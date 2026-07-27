import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
  AgentEvent,
  AgentMessage,
  ExecutionContext,
  JsonValue,
  RunId,
} from '../core';
import type { ModelUsage } from '../models';

export type SessionId = string;
export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface ApprovalRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  risk: 'read' | 'write' | 'sensitive' | 'destructive';
  requestedAt: string;
}

export type RunPause =
  | { type: 'approval'; approval: ApprovalRequest }
  | {
      type: 'tool_execution_unknown';
      toolCallId: string;
      toolName: string;
      input: JsonValue;
    };

export interface ApprovalResolution {
  type: 'approval';
  approvalId: string;
  decision: 'approve' | 'reject';
  actor: { id: string; type?: string };
}

export type ToolExecutionResolution =
  | {
      type: 'tool_execution';
      toolCallId: string;
      decision: 'use_output';
      output: JsonValue;
      actor: { id: string; type?: string };
    }
  | {
      type: 'tool_execution';
      toolCallId: string;
      decision: 'retry';
      actor: { id: string; type?: string };
    };

export type ResumeRunResolution = ApprovalResolution | ToolExecutionResolution;

export interface AgentRun<TOutput = JsonValue> {
  id: RunId;
  sessionId: SessionId;
  agentName: string;
  status: RunStatus;
  revision: number;
  pause?: RunPause;
  createdAt: string;
  updatedAt: string;
  output?: TOutput;
  error?: string;
  usage?: ModelUsage;
}

export interface Session {
  id: SessionId;
  history: AgentMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ListEventsOptions {
  after?: AgentEvent['id'];
}

export interface RunStore {
  getRun(runId: RunId): Promise<AgentRun | undefined>;
  saveRun(run: AgentRun): Promise<void>;
  getSession(sessionId: SessionId): Promise<Session | undefined>;
  saveSession(session: Session): Promise<void>;
  appendEvent(event: AgentEvent): Promise<void>;
  listEvents(runId: RunId, options?: ListEventsOptions): Promise<AgentEvent[]>;
}

export interface CredentialStore {
  resolve(input: {
    name: string;
    namespace?: string;
    actor?: { id: string; type?: string };
  }): Promise<string | undefined>;
}

export interface PendingToolExecution {
  call: { id: string; name: string; input: JsonValue };
  input: JsonValue;
  idempotencyKey: string;
  attempt: number;
}

export interface RunCheckpoint {
  runId: RunId;
  definitionHash: string;
  messages: AgentMessage[];
  inputContent: string;
  context?: ExecutionContext;
  usage?: ModelUsage;
  providerState?: JsonValue;
  step: number;
  toolCallCount: number;
  seenToolCallIds: string[];
  pendingTools: PendingToolExecution[];
  pendingIndex: number;
}

export type ToolExecutionStatus = 'started' | 'completed' | 'failed' | 'unknown';

export interface ToolExecutionRecord {
  runId: RunId;
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  status: ToolExecutionStatus;
  attempt: number;
  idempotencyKey: string;
  output?: JsonValue;
  error?: string;
  updatedAt: string;
}

export interface RunLease {
  runId: RunId;
  ownerId: string;
  expiresAt: string;
}

export interface ExecutionCommit {
  expectedRevision: number;
  run: AgentRun;
  checkpoint?: RunCheckpoint | null;
  session?: Session;
  toolExecution?: ToolExecutionRecord;
  events?: AgentEvent[];
}

export interface DurableRunStore extends RunStore {
  getCheckpoint(runId: RunId): Promise<RunCheckpoint | undefined>;
  getToolExecution(runId: RunId, toolCallId: string): Promise<ToolExecutionRecord | undefined>;
  commitExecution(commit: ExecutionCommit): Promise<boolean>;
  acquireLease(lease: RunLease): Promise<boolean>;
  renewLease(lease: RunLease): Promise<boolean>;
  releaseLease(runId: RunId, ownerId: string): Promise<void>;
}

export function isDurableRunStore(store: RunStore): store is DurableRunStore {
  const value = store as Partial<DurableRunStore>;
  return [
    value.getCheckpoint,
    value.getToolExecution,
    value.commitExecution,
    value.acquireLease,
    value.renewLease,
    value.releaseLease,
  ].every((method) => typeof method === 'function');
}

export class InMemoryRunStore implements DurableRunStore {
  readonly #runs = new Map<RunId, AgentRun>();
  readonly #sessions = new Map<SessionId, Session>();
  readonly #events = new Map<RunId, AgentEvent[]>();
  readonly #checkpoints = new Map<RunId, RunCheckpoint>();
  readonly #toolExecutions = new Map<string, ToolExecutionRecord>();
  readonly #leases = new Map<RunId, RunLease>();

  async getRun(runId: RunId): Promise<AgentRun | undefined> {
    const run = this.#runs.get(runId);
    return run === undefined ? undefined : structuredClone(run);
  }

  async saveRun(run: AgentRun): Promise<void> {
    this.#runs.set(run.id, structuredClone(run));
    if (!this.#events.has(run.id)) this.#events.set(run.id, []);
  }

  async getSession(sessionId: SessionId): Promise<Session | undefined> {
    const session = this.#sessions.get(sessionId);
    return session === undefined ? undefined : structuredClone(session);
  }

  async saveSession(session: Session): Promise<void> {
    this.#sessions.set(session.id, structuredClone(session));
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    const events = this.#events.get(event.runId);
    if (!events) throw new Error(`Run "${event.runId}" does not exist`);
    events.push(structuredClone(event));
  }

  async listEvents(runId: RunId, options: ListEventsOptions = {}): Promise<AgentEvent[]> {
    const events = this.#events.get(runId);
    if (!events) throw new Error(`Run "${runId}" does not exist`);

    let start = 0;
    if (options.after !== undefined) {
      const cursor = events.findIndex(({ id }) => id === options.after);
      if (cursor < 0) {
        throw new Error(`Event cursor "${options.after}" does not exist in run "${runId}"`);
      }
      start = cursor + 1;
    }

    return structuredClone(events.slice(start).sort((a, b) => a.sequence - b.sequence));
  }

  async getCheckpoint(runId: RunId): Promise<RunCheckpoint | undefined> {
    const checkpoint = this.#checkpoints.get(runId);
    return checkpoint === undefined ? undefined : structuredClone(checkpoint);
  }

  async getToolExecution(
    runId: RunId,
    toolCallId: string,
  ): Promise<ToolExecutionRecord | undefined> {
    const execution = this.#toolExecutions.get(`${runId}:${toolCallId}`);
    return execution === undefined ? undefined : structuredClone(execution);
  }

  async commitExecution(commit: ExecutionCommit): Promise<boolean> {
    const current = this.#runs.get(commit.run.id);
    if (!current || current.revision !== commit.expectedRevision) return false;

    const run = structuredClone(commit.run);
    run.revision = commit.expectedRevision + 1;
    this.#runs.set(run.id, run);
    commit.run.revision = run.revision;
    if (commit.session) this.#sessions.set(commit.session.id, structuredClone(commit.session));
    if (commit.checkpoint === null) this.#checkpoints.delete(run.id);
    else if (commit.checkpoint) this.#checkpoints.set(run.id, structuredClone(commit.checkpoint));
    if (commit.toolExecution) {
      this.#toolExecutions.set(
        `${run.id}:${commit.toolExecution.toolCallId}`,
        structuredClone(commit.toolExecution),
      );
    }
    const events = this.#events.get(run.id);
    if (!events) throw new Error(`Run "${run.id}" does not exist`);
    for (const event of commit.events ?? []) events.push(structuredClone(event));
    return true;
  }

  async acquireLease(lease: RunLease): Promise<boolean> {
    const current = this.#leases.get(lease.runId);
    if (
      current
      && current.ownerId !== lease.ownerId
      && Date.parse(current.expiresAt) > Date.now()
    ) return false;
    this.#leases.set(lease.runId, structuredClone(lease));
    return true;
  }

  async renewLease(lease: RunLease): Promise<boolean> {
    const current = this.#leases.get(lease.runId);
    if (!current || current.ownerId !== lease.ownerId) return false;
    this.#leases.set(lease.runId, structuredClone(lease));
    return true;
  }

  async releaseLease(runId: RunId, ownerId: string): Promise<void> {
    if (this.#leases.get(runId)?.ownerId === ownerId) this.#leases.delete(runId);
  }
}

export interface RunRequest<TInput = unknown, TOutput = unknown> {
  input: TInput;
  context?: ExecutionContext;
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  sessionId?: SessionId;
  signal?: AbortSignal;
}

export interface RunResult<TOutput = unknown> {
  runId: RunId;
  sessionId: SessionId;
  output: TOutput;
  events?: AgentEvent[];
  usage?: ModelUsage;
}
