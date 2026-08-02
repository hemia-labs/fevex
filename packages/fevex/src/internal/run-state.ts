import type { AgentEvent } from '../core';
import type {
  AgentRun,
  CoordinatorCheckpoint,
  CoordinatorRun,
  RunCheckpoint,
  RunRequest,
  Session,
} from '../runtime';

/** Mutable in-process state of a single agent run. */
export interface ExecutionState<TInput = unknown, TOutput = unknown> {
  run: AgentRun;
  session: Session;
  request: RunRequest<TInput, TOutput> & { signal: AbortSignal };
  controller: AbortController;
  eventSequence: number;
  advancing: boolean;
  checkpoint?: RunCheckpoint;
  approvedToolCallId?: string;
  forcedRetryToolCallId?: string;
  leaseOwner?: string;
  leaseTimer?: ReturnType<typeof setInterval>;
  initialEvents?: AgentEvent[];
}

/** Mutable in-process state of a single workflow or team run. */
export interface WorkflowExecutionState<TInput = unknown, TOutput = unknown> {
  run: CoordinatorRun;
  session: Session;
  request: RunRequest<TInput, TOutput> & { signal: AbortSignal };
  controller: AbortController;
  eventSequence: number;
  checkpoint: CoordinatorCheckpoint;
  advancing: boolean;
  leaseOwner?: string;
  leaseTimer?: ReturnType<typeof setInterval>;
  commitQueue: Promise<void>;
  initialEvents?: AgentEvent[];
  recoveryActor?: { id: string; type?: string };
}
