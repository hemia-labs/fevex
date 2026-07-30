import type {
  AgentEvent,
  AgentMessage,
  ExecutionContext,
  JsonObject,
  JsonValue,
  RunId,
} from '../core';
import type { ModelUsage } from '../models';
import type { AgentLimits } from '../agents';

/** Stable identifier for conversation history shared across runs. */
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

export type AgentRunPause =
  | { type: 'approval'; approval: ApprovalRequest }
  | {
      type: 'tool_execution_unknown';
      toolCallId: string;
      toolName: string;
      input: JsonValue;
    };

export type RunPause =
  | AgentRunPause
  | {
      type: 'workflow_child';
      childRunId: RunId;
      childPause: AgentRunPause;
    }
  | {
      type: 'workflow_timer';
      stepId: string;
      resumeAt: string;
    }
  | {
      type: 'workflow_event';
      stepId: string;
      eventName: string;
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

export type TimerResolution = {
  type: 'timer';
  actor?: { id: string; type?: string };
};

export type EventResolution = {
  type: 'event';
  eventName: string;
  payload?: JsonValue;
  actor?: { id: string; type?: string };
};

export type ResumeRunResolution =
  | ApprovalResolution
  | ToolExecutionResolution
  | TimerResolution
  | EventResolution;

export interface AgentRun<TOutput = JsonValue> {
  kind?: 'agent';
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

export interface WorkflowRun<TOutput = JsonValue> {
  kind: 'workflow';
  id: RunId;
  sessionId: SessionId;
  workflowName: string;
  status: RunStatus;
  revision: number;
  pause?: RunPause;
  createdAt: string;
  updatedAt: string;
  output?: TOutput;
  error?: string;
  usage?: ModelUsage;
}

export interface TeamRun<TOutput = JsonValue> {
  kind: 'team';
  id: RunId;
  sessionId: SessionId;
  teamName: string;
  status: RunStatus;
  revision: number;
  pause?: RunPause;
  createdAt: string;
  updatedAt: string;
  output?: TOutput;
  error?: string;
  usage?: ModelUsage;
}

export type CoordinatorRun<TOutput = JsonValue> =
  | WorkflowRun<TOutput>
  | TeamRun<TOutput>;

export type RunRecord<TOutput = unknown> =
  | AgentRun<TOutput>
  | WorkflowRun<TOutput>
  | TeamRun<TOutput>;

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
  getRun<TRun extends RunRecord<unknown> = AgentRun>(runId: RunId): Promise<TRun | undefined>;
  saveRun(run: RunRecord): Promise<void>;
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
  version: 2;
  kind?: 'agent';
  runId: RunId;
  definitionHash: string;
  limits?: AgentLimits;
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

export type WorkflowStepRecord =
  | {
      type: 'agent';
      status: 'running';
      agentName: string;
      childRunId: RunId;
      metadata?: JsonObject;
    }
  | {
      type: 'agent';
      status: 'completed';
      agentName: string;
      childRunId: RunId;
      result: RunResult<JsonValue>;
      compensation?: WorkflowCompensationRecord;
      metadata?: JsonObject;
    }
  | {
      type: 'parallel';
      status: 'running';
      metadata?: JsonObject;
    }
  | {
      type: 'parallel';
      status: 'completed';
      result: JsonObject;
      compensation?: WorkflowCompensationRecord;
      metadata?: JsonObject;
    }
  | {
      type: 'wait';
      status: 'running';
      wait: WorkflowWaitRecord;
    }
  | {
      type: 'wait';
      status: 'completed';
      wait: WorkflowWaitRecord;
      payload?: JsonValue;
      actor?: NonNullable<ExecutionContext['actor']>;
      receivedAt?: string;
    };

export interface WorkflowCompensationRecord {
  status: 'pending' | 'completed' | 'failed';
  error?: string;
}

export type WorkflowWaitRecord =
  | { type: 'timer'; resumeAt: string }
  | { type: 'event'; eventName: string; requireActor: boolean };

export interface WorkflowBudgetUsage {
  usage?: ModelUsage;
  steps: number;
  toolCalls: number;
}

export interface WorkflowCheckpoint {
  version: 2;
  kind: 'workflow';
  runId: RunId;
  workflowName: string;
  definitionHash: string;
  input: JsonValue;
  context?: ExecutionContext;
  steps: Record<string, WorkflowStepRecord>;
  limits?: AgentLimits;
  budget?: WorkflowBudgetUsage;
}

export interface TeamCheckpoint
  extends Omit<WorkflowCheckpoint, 'kind' | 'workflowName'> {
  kind: 'team';
  teamName: string;
}

export type CoordinatorCheckpoint = WorkflowCheckpoint | TeamCheckpoint;

export type StoredRunCheckpoint = RunCheckpoint | WorkflowCheckpoint | TeamCheckpoint;

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
  run: RunRecord;
  checkpoint?: StoredRunCheckpoint | null;
  session?: Session;
  toolExecution?: ToolExecutionRecord;
  events?: AgentEvent[];
}

export interface ExecutionCreate {
  run: RunRecord;
  checkpoint: StoredRunCheckpoint;
  session?: Session;
  lease: RunLease;
  events: AgentEvent[];
}

export interface DurableRunStore extends RunStore {
  getCheckpoint<TCheckpoint extends StoredRunCheckpoint = RunCheckpoint>(
    runId: RunId,
  ): Promise<TCheckpoint | undefined>;
  getToolExecution(runId: RunId, toolCallId: string): Promise<ToolExecutionRecord | undefined>;
  createExecution(create: ExecutionCreate): Promise<boolean>;
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
    value.createExecution,
    value.commitExecution,
    value.acquireLease,
    value.renewLease,
    value.releaseLease,
  ].every((method) => typeof method === 'function');
}

export interface RunRequest<TInput = unknown, TOutput = unknown> {
  input: TInput;
  context?: ExecutionContext;
  limits?: AgentLimits;
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
