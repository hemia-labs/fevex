import type { AgentEvent, ExecutionContext, JsonObject, RunId } from '../core';
import type { Fevex } from '../fevex';
import type { AgentRun, ElicitationRequest, SessionId } from '../runtime';

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

export interface ChannelElicitationContext extends ChannelContext {
  /** Stable key for transport-level idempotency, preserved across delivery retries. */
  deliveryId: string;
  runId: RunId;
  sessionId: SessionId;
  conversationId: string;
  threadId?: string;
}

export interface ChannelAdapter<TInput = unknown, TOutput = unknown> {
  name: string;
  parse(input: TInput, context: ChannelContext): Promise<ChannelMessage | null>;
  deliver(output: ChannelOutput, context: ChannelContext): Promise<TOutput>;
  deliverElicitation?(request: ElicitationRequest, context: ChannelElicitationContext): Promise<TOutput>;
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
  runId?: RunId;
  requestId?: string;
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
  readonly runId?: RunId;

  constructor(
    readonly code: string,
    readonly safeMessage: string,
    options?: ErrorOptions & { runId?: RunId },
  ) {
    super(safeMessage, options);
    this.runId = options?.runId;
  }
}

export interface ChannelDeliveryOptions<TInput = unknown, TDelivery = unknown> {
  fevex: Fevex;
  adapter: ChannelAdapter<TInput, TDelivery>;
  onEvent?: (event: ChannelEvent) => void;
  signal?: AbortSignal;
}

export interface ChannelRunOptions<TInput = unknown, TDelivery = unknown>
  extends ChannelDeliveryOptions<TInput, TDelivery> {
  agentName: string;
  resolveSessionId?: (message: ChannelMessage) => SessionId | undefined | Promise<SessionId | undefined>;
}

export type ChannelRunResult<TDelivery = unknown> =
  | { ignored: true; events: ChannelRunEvent[] }
  | {
      ignored: false;
      message: ChannelMessage;
      run: AgentRun;
      output: ChannelOutput;
      delivery: TDelivery;
      /** Present when the agent is waiting for external information. */
      elicitation?: ElicitationRequest;
      events: ChannelRunEvent[];
    };
