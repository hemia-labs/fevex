import type { AgentEvent, ExecutionContext, JsonValue } from '../core';
import type { Fevex } from '../fevex';
import type {
  AgentRun,
  RunRecord,
  SessionId,
  TeamRun,
  WorkflowRun,
} from '../runtime';

export const FEVEX_HTTP_PROTOCOL_VERSION = '3';
export const FEVEX_HTTP_PROTOCOL_VERSION_HEADER = 'Fevex-Protocol-Version';

export interface StartRunHttpRequest<TInput extends JsonValue = JsonValue> {
  input: TInput;
  sessionId?: SessionId;
}

export type ResumeRunHttpRequest =
  | { type: 'elicitation'; requestId: string; value: JsonValue }
  | { type: 'approval'; approvalId: string; decision: 'approve' | 'reject' }
  | {
      type: 'tool_execution';
      toolCallId: string;
      decision: 'use_output';
      output: JsonValue;
    }
  | { type: 'tool_execution'; toolCallId: string; decision: 'retry' }
  | { type: 'timer' }
  | { type: 'event'; eventName: string; payload?: JsonValue };

/** RFC 9457-compatible problem returned by the Fevex HTTP protocol. */
export interface FevexProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
}

export interface FevexHttpHandlerContext {
  context?: ExecutionContext;
}

export interface FevexHttpHandlerOptions {
  fevex: Fevex;
  pollIntervalMs?: number;
}

export type FevexHttpHandler = (
  request: Request,
  context?: FevexHttpHandlerContext,
) => Promise<Response>;

export interface FevexHttpClientOptions {
  baseUrl: string;
  fetch?: FevexHttpFetch;
}

export type FevexHttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ObserveRunOptions {
  after?: AgentEvent['id'];
  signal?: AbortSignal;
}

export interface FevexHttpClient {
  startRun<TInput extends JsonValue = JsonValue, TOutput = JsonValue>(
    agentName: string,
    request: StartRunHttpRequest<TInput>,
  ): Promise<AgentRun<TOutput>>;
  startWorkflow<TInput extends JsonValue = JsonValue, TOutput = JsonValue>(
    workflowName: string,
    request: StartRunHttpRequest<TInput>,
  ): Promise<WorkflowRun<TOutput>>;
  startTeam<TInput extends JsonValue = JsonValue, TOutput = JsonValue>(
    teamName: string,
    request: StartRunHttpRequest<TInput>,
  ): Promise<TeamRun<TOutput>>;
  getRun<TOutput = JsonValue>(runId: string): Promise<RunRecord<TOutput>>;
  observeRun(runId: string, options?: ObserveRunOptions): AsyncIterable<AgentEvent>;
  resumeRun<TOutput = JsonValue>(
    runId: string,
    request: ResumeRunHttpRequest,
  ): Promise<RunRecord<TOutput>>;
  recoverRun<TOutput = JsonValue>(runId: string): Promise<RunRecord<TOutput>>;
  cancelRun(runId: string): Promise<void>;
}
