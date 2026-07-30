import type { ExecutionContext, JsonValue } from '../core';
import type { RunResult } from '../runtime';
import {
  ChannelError,
  type ChannelEvent,
  type ChannelFailurePhase,
  type ChannelMessage,
  type ChannelOutput,
  type ChannelRunOptions,
  type ChannelRunResult,
} from './channel';

/** Parses one channel input, runs the configured agent, and delivers its output. */
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

  let result: RunResult<JsonValue>;
  try {
    const sessionId = await options.resolveSessionId?.(message);
    result = await options.fevex.runAgent<string, JsonValue>(options.agentName, {
      input: message.content,
      ...(sessionId ? { sessionId } : {}),
      context: channelContext(options.adapter.name, message),
      signal: options.signal,
    });
  } catch (cause) {
    const error = channelError('CHANNEL_RUN_FAILED', 'Channel run failed', cause);
    emit(failed(options.adapter.name, 'run', error, message));
    throw error;
  }

  const run = await options.fevex.getRun<JsonValue>(result.runId);
  if (!run || run.kind === 'workflow' || run.kind === 'team') {
    const error = channelError('CHANNEL_RUN_FAILED', 'Channel run was not found after completion');
    emit(failed(options.adapter.name, 'run', error, message));
    throw error;
  }

  const output: ChannelOutput = {
    deliveryId: message.deliveryId,
    conversationId: message.conversationId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    content: stringifyOutput(result.output),
    metadata: { runId: result.runId, sessionId: result.sessionId },
  };

  let delivery: TDelivery;
  try {
    delivery = await options.adapter.deliver(output, { signal: options.signal });
  } catch (cause) {
    const error = channelError('CHANNEL_DELIVERY_FAILED', 'Channel delivery failed', cause);
    emit(failed(options.adapter.name, 'deliver', error, message));
    throw error;
  }

  const deliveredEvent = delivered(options.adapter.name, message);
  emit(deliveredEvent);

  return {
    ignored: false,
    message,
    run,
    output,
    delivery,
    events: [channelEvents[0]!, ...(result.events ?? []), deliveredEvent],
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

function channelError(code: string, safeMessage: string, cause?: unknown): ChannelError {
  return new ChannelError(code, safeMessage, cause === undefined ? undefined : { cause });
}

function stringifyOutput(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
