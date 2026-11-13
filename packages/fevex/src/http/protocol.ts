import type { AgentEvent, ExecutionContext, JsonValue, RunId } from '../core';
import type { ArtifactCatalog, ArtifactDescriptor, ArtifactStore } from '../artifacts';
import type { Fevex } from '../fevex';
import type { ReasoningEffort } from '../models';
import type {
  AgentRun,
  ListRunsOptions,
  RunPage,
  RunRecord,
  SessionId,
  TeamRun,
  WorkflowRun,
} from '../runtime';

export const FEVEX_HTTP_PROTOCOL_VERSION = '3';
export const FEVEX_HTTP_PROTOCOL_VERSION_HEADER = 'Fevex-Protocol-Version';

export interface StartRunHttpRequest<TInput extends JsonValue = JsonValue> {
  input: TInput;
  model?: string;
  reasoning?: ReasoningEffort;
  sessionId?: SessionId;
  /** Maximum wall-clock time for the run, including time spent paused. */
  deadlineMs?: number;
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

/** Host-facing resource access check. */
export type FevexHttpAccess =
  | {
      action: 'start';
      kind: 'agent' | 'workflow' | 'team';
      name: string;
      sessionId?: SessionId;
      context?: ExecutionContext;
    }
  | {
      action: 'read' | 'observe' | 'cancel' | 'resume' | 'recover';
      runId: RunId;
      context?: ExecutionContext;
    };

/** Host-facing artifact access check. */
export type FevexArtifactAccess =
  | {
      action: 'read' | 'delete';
      kind: 'artifact';
      artifactId: string;
      context?: ExecutionContext;
    }
  | {
      action: 'read';
      kind: 'artifacts';
      runId: RunId;
      context?: ExecutionContext;
    };

export interface FevexHttpHandlerOptions {
  fevex: Fevex;
  pollIntervalMs?: number;
  /** Events per SSE read (default 100, maximum 1000). */
  eventPageSize?: number;
  /** Maximum concurrent SSE streams (default unlimited). */
  maxConnections?: number;
  /**
   * Authorizes a resource operation before the handler reads or mutates a run,
   * or starts a run (new or existing session). Return false for a 403 response.
   * For `GET /v1/runs`, false filters that run out of the page.
   * Omit to preserve the host's existing trusted-network behavior.
   */
  authorize?: (access: FevexHttpAccess) => boolean | Promise<boolean>;
  /**
   * Byte store used by the artifact routes. When omitted, artifact routes
   * return 501.
   */
  artifacts?: ArtifactStore;
  /**
   * Metadata catalog used to list artifacts for a run. When omitted, the
   * run-artifact listing route returns 501.
   */
  artifactCatalog?: ArtifactCatalog;
  /**
   * Authorizes artifact reads, listings and deletions. Omit to preserve the
   * host's existing trusted-network behavior.
   */
  authorizeArtifact?: (access: FevexArtifactAccess) => boolean | Promise<boolean>;
  /**
   * Called after a run starts so the host can persist run and session ownership.
   * If it throws, the handler cancels the new run and returns 500. A process
   * crash between start and this callback leaves the run unowned; hosts must
   * treat unowned runs as inaccessible. Runs created outside the HTTP handler
   * are not reported.
   */
  onRunStarted?: (
    run: RunRecord,
    context?: ExecutionContext,
  ) => void | Promise<void>;
  onError?: (error: unknown, problem: FevexProblemDetails) => void;
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
  listRuns(options?: ListRunsOptions): Promise<RunPage>;
  observeRun(runId: string, options?: ObserveRunOptions): AsyncIterable<AgentEvent>;
  resumeRun<TOutput = JsonValue>(
    runId: string,
    request: ResumeRunHttpRequest,
  ): Promise<RunRecord<TOutput>>;
  recoverRun<TOutput = JsonValue>(runId: string): Promise<RunRecord<TOutput>>;
  cancelRun(runId: string): Promise<void>;
  getArtifact(artifactId: string): Promise<Response>;
  listArtifacts(runId: string): Promise<ArtifactDescriptor[]>;
  deleteArtifact(artifactId: string): Promise<void>;
}
