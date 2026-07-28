import type { AgentEvent, ExecutionContext, JsonObject, JsonValue } from '../core';
import type { Fevex } from '../fevex';
import type { AgentRun, RunResult, SessionId } from '../runtime';

export interface ChannelMessage {
  id: string;
  deliveryId: string;
  conversationId: string;
  threadId?: string;
  content: string;
  actor?: ExecutionContext['actor'];
  metadata?: JsonObject;
}

export interface ChannelOutput {
  deliveryId: string;
  conversationId: string;
  threadId?: string;
  content: string;
  metadata?: JsonObject;
}

export interface ChannelContext {
  signal?: AbortSignal;
}

export interface ChannelAdapter<TInput = unknown, TOutput = unknown> {
  name: string;
  parse(input: TInput, context: ChannelContext): Promise<ChannelMessage | null>;
  deliver(output: ChannelOutput, context: ChannelContext): Promise<TOutput>;
}

export type ChannelEventType = 'channel.received' | 'channel.delivered' | 'channel.failed';
export type ChannelFailurePhase = 'parse' | 'run' | 'deliver';

interface ChannelEventBase {
  id: string;
  timestamp: string;
  adapter: string;
  messageId?: string;
  deliveryId?: string;
  conversationId?: string;
  threadId?: string;
}

export type ChannelEvent =
  | (ChannelEventBase & {
      type: 'channel.received';
      actor?: ExecutionContext['actor'];
    })
  | (ChannelEventBase & {
      type: 'channel.delivered';
    })
  | (ChannelEventBase & {
      type: 'channel.failed';
      phase: ChannelFailurePhase;
      error: string;
    });

export type ChannelRunEvent = ChannelEvent | AgentEvent;

export class ChannelError extends Error {
  readonly name = 'ChannelError';

  constructor(
    readonly code: string,
    readonly safeMessage: string,
    options?: ErrorOptions,
  ) {
    super(safeMessage, options);
  }
}

export interface ChannelRunOptions<TInput = unknown, TDelivery = unknown> {
  fevex: Fevex;
  adapter: ChannelAdapter<TInput, TDelivery>;
  agentName: string;
  resolveSessionId?: (message: ChannelMessage) => SessionId | undefined | Promise<SessionId | undefined>;
  onEvent?: (event: ChannelEvent) => void;
  signal?: AbortSignal;
}

export type ChannelRunResult<TDelivery = unknown> =
  | { ignored: true; events: ChannelRunEvent[] }
  | {
      ignored: false;
      message: ChannelMessage;
      run: AgentRun;
      output: ChannelOutput;
      delivery: TDelivery;
      events: ChannelRunEvent[];
    };

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
  if (!run || run.kind === 'workflow') {
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
