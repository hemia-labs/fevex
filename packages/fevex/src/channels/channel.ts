import type { AgentEvent, ExecutionContext, JsonObject } from '../core';
import type { Fevex } from '../fevex';
import type { AgentRun, SessionId } from '../runtime';

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
