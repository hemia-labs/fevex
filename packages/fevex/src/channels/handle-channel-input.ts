import type { ExecutionContext, JsonValue, RunId } from '../core';
import { RunPausedError } from '../run-error';
import type { RunResult } from '../runtime';
import {
  ChannelError,
  type ChannelDeliveryOptions,
  type ChannelEvent,
  type ChannelFailurePhase,
  type ChannelMessage,
  type ChannelOutput,
  type ChannelRunOptions,
  type ChannelRunResult,
} from './channel';

/** Parses one channel input, runs the configured agent, and delivers its result or elicitation. */
export async function handleChannelInput<TInput, TDelivery>(
  input: TInput,
  options: ChannelRunOptions<TInput, TDelivery>,
): Promise<ChannelRunResult<TDelivery>> {
  const channelEvents: ChannelEvent[] = [];

  const emit = (event: ChannelEvent) => {
    channelEvents.push(event);
    options.onEvent?.(event);
  };

  let parsed: ChannelMessage | null;
  try {
    parsed = await options.adapter.parse(input, { signal: options.signal });
  } catch (cause) {
    const error = channelError('CHANNEL_PARSE_FAILED', 'Channel parse failed', cause);
    emit(failed(options.adapter.name, 'parse', error));
    throw error;
  }

  if (parsed === null) return { ignored: true, events: [] };
  const message = parsed;

  emit(received(options.adapter.name, message));

  let runId: RunId;
  try {
    const sessionId = await options.resolveSessionId?.(message);
    const result: RunResult<JsonValue> = await options.fevex.runAgent<string, JsonValue>(options.agentName, {
      input: message.content,
      ...(sessionId ? { sessionId } : {}),
      context: channelContext(options.adapter.name, message),
      signal: options.signal,
    });
    runId = result.runId;
  } catch (cause) {
    if (cause instanceof RunPausedError && cause.pause.type === 'elicitation') {
      runId = cause.runId;
    } else {
      const error = channelError('CHANNEL_RUN_FAILED', 'Channel run failed', cause);
      emit(failed(options.adapter.name, 'run', error, message));
      throw error;
    }
  }

  const delivered = await deliverChannelRun(runId, message, options);
  return { ...delivered, events: [channelEvents[0]!, ...delivered.events] };
}

/** Delivers a stored agent result or elicitation without executing the agent again. */
export async function deliverChannelRun<TInput, TDelivery>(
  runId: RunId,
  message: ChannelMessage,
  options: ChannelDeliveryOptions<TInput, TDelivery>,
): Promise<Exclude<ChannelRunResult<TDelivery>, { ignored: true }>> {
  options.signal?.throwIfAborted();
  const run = await options.fevex.getRun<JsonValue>(runId);
  const elicitation = run?.status === 'paused' && run.pause?.type === 'elicitation'
    ? run.pause.request
    : undefined;
  if (!run || run.kind === 'workflow' || run.kind === 'team'
    || (run.status !== 'completed' && !elicitation)) {
    const error = channelError('CHANNEL_RUN_FAILED', 'Channel run is not ready for delivery', undefined, runId);
    options.onEvent?.(failed(options.adapter.name, 'run', error, message));
    throw error;
  }

  const output: ChannelOutput = {
    deliveryId: elicitation ? `elicitation:${runId}:${elicitation.id}` : message.deliveryId,
    conversationId: message.conversationId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    content: elicitation ? elicitation.prompt : stringifyOutput(run.output ?? null),
    metadata: {
      runId,
      sessionId: run.sessionId,
      ...(elicitation ? { requestId: elicitation.id } : {}),
    },
  };

  let delivery: TDelivery;
  try {
    if (elicitation) {
      if (!options.adapter.deliverElicitation) {
        throw channelError('CHANNEL_ELICITATION_UNSUPPORTED', 'Channel does not support elicitation delivery', undefined, runId);
      }
      if (elicitation.expiresAt && Date.now() > Date.parse(elicitation.expiresAt)) {
        throw channelError('CHANNEL_ELICITATION_EXPIRED', 'Channel elicitation has expired', undefined, runId);
      }
      delivery = await options.adapter.deliverElicitation(elicitation, {
        signal: options.signal,
        deliveryId: output.deliveryId,
        runId,
        sessionId: run.sessionId,
        conversationId: message.conversationId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
      });
    } else {
      delivery = await options.adapter.deliver(output, { signal: options.signal });
    }
  } catch (cause) {
    const error = cause instanceof ChannelError
      ? channelError(cause.code, cause.safeMessage, cause, runId)
      : channelError('CHANNEL_DELIVERY_FAILED', 'Channel delivery failed', cause, runId);
    options.onEvent?.({
      ...failed(options.adapter.name, 'deliver', error, { ...message, deliveryId: output.deliveryId }),
      ...(elicitation ? { requestId: elicitation.id } : {}),
    });
    throw error;
  }

  const deliveredEvent = {
    ...delivered(options.adapter.name, { ...message, deliveryId: output.deliveryId }),
    runId,
    ...(elicitation ? { requestId: elicitation.id } : {}),
  };
  options.onEvent?.(deliveredEvent);

  return {
    ignored: false,
    message,
    run,
    output,
    delivery,
    ...(elicitation ? { elicitation } : {}),
    events: [...await options.fevex.listEvents(runId), deliveredEvent],
  };
}

function channelContext(adapter: string, message: ChannelMessage): ExecutionContext {
  return {
    namespace: adapter,
    ...(message.actor ? { actor: message.actor } : {}),
    attributes: {
      ...(message.metadata ?? {}),
      channel: adapter,
      messageId: message.id,
      deliveryId: message.deliveryId,
      conversationId: message.conversationId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
    },
  };
}

function received(adapter: string, message: ChannelMessage): ChannelEvent {
  return {
    type: 'channel.received',
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    adapter,
    messageId: message.id,
    deliveryId: message.deliveryId,
    conversationId: message.conversationId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.actor ? { actor: message.actor } : {}),
  };
}

function delivered(adapter: string, message: ChannelMessage): ChannelEvent {
  return {
    type: 'channel.delivered',
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    adapter,
    messageId: message.id,
    deliveryId: message.deliveryId,
    conversationId: message.conversationId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
  };
}

function failed(
  adapter: string,
  phase: ChannelFailurePhase,
  error: ChannelError,
  message?: ChannelMessage,
): ChannelEvent {
  return {
    type: 'channel.failed',
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    adapter,
    phase,
    error: error.safeMessage,
    ...(error.runId ? { runId: error.runId } : {}),
    ...(message
      ? {
          messageId: message.id,
          deliveryId: message.deliveryId,
          conversationId: message.conversationId,
          ...(message.threadId ? { threadId: message.threadId } : {}),
        }
      : {}),
  };
}

function channelError(code: string, safeMessage: string, cause?: unknown, runId?: RunId): ChannelError {
  return new ChannelError(code, safeMessage, { ...(cause === undefined ? {} : { cause }), ...(runId ? { runId } : {}) });
}

function stringifyOutput(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
