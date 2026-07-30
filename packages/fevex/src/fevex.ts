import type { AgentDefinition } from './agents';
import type { AgentEvent, RunId } from './core';
import { createComposition } from './internal/configuration';
import { createRuntime } from './internal/runtime';
import type { ContextProvider, MemoryStore } from './knowledge';
import type { ModelGateway } from './models';
import type { ObservabilityOptions } from './observability';
import type { PolicyDefinition } from './policies';
import type { Sandbox } from './sandbox';
import type {
  AgentRun,
  CredentialStore,
  ListEventsOptions,
  ResumeRunResolution,
  RunRecord,
  RunRequest,
  RunResult,
  RunStore,
  Session,
  SessionId,
  WorkflowRun,
  TeamRun,
} from './runtime';
import type { TeamDefinition } from './teams';
import type { ConnectionDefinition, ToolDefinition } from './tools';
import type { WorkflowDefinition } from './workflows';

/** Provider-neutral definitions and adapters used to create one Fevex runtime. */
export interface FevexConfig {
  models: Record<string, ModelGateway>;
  agents: AgentDefinition[];
  workflows?: WorkflowDefinition[];
  teams?: TeamDefinition[];
  tools?: ToolDefinition[];
  connections?: ConnectionDefinition[];
  contextProviders?: ContextProvider[];
  memoryStore?: MemoryStore;
  runStore?: RunStore;
  credentialStore?: CredentialStore;
  sandbox?: Sandbox;
  policies?: PolicyDefinition[];
  onEvent?: (event: AgentEvent) => void;
  observability?: ObservabilityOptions;
}

export interface Fevex {
  startAgent<TInput = unknown, TOutput = unknown>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): Promise<AgentRun<TOutput>>;
  runAgent<TInput = unknown, TOutput = unknown>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): Promise<RunResult<TOutput>>;
  streamAgent<TInput = unknown, TOutput = unknown>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): AsyncIterable<AgentEvent>;
  startWorkflow<TInput = unknown, TOutput = unknown>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): Promise<WorkflowRun<TOutput>>;
  runWorkflow<TInput = unknown, TOutput = unknown>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): Promise<RunResult<TOutput>>;
  startTeam<TInput = unknown, TOutput = unknown>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): Promise<TeamRun<TOutput>>;
  runTeam<TInput = unknown, TOutput = unknown>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): Promise<RunResult<TOutput>>;
  streamTeam<TInput = unknown, TOutput = unknown>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): AsyncIterable<AgentEvent>;
  getTeamRun<TOutput = unknown>(runId: RunId): Promise<TeamRun<TOutput> | undefined>;
  getRun<TOutput = unknown>(runId: RunId): Promise<RunRecord<TOutput> | undefined>;
  listEvents(runId: RunId, options?: ListEventsOptions): Promise<AgentEvent[]>;
  cancelRun(runId: RunId): Promise<boolean>;
  resumeRun<TOutput = unknown>(
    runId: RunId,
    resolution: ResumeRunResolution,
  ): Promise<RunRecord<TOutput>>;
  recoverRun<TOutput = unknown>(
    runId: RunId,
    options: { actor: { id: string; type?: string } },
  ): Promise<RunRecord<TOutput>>;
  compactSession(sessionId: SessionId, summary: string): Promise<Session>;
  flushObservability(): Promise<void>;
}

/**
 * Validates a configuration snapshot and creates an isolated runtime.
 *
 * The runtime does not own external adapters; callers remain responsible for
 * closing model, connection, store, and exporter resources they provide.
 */
export function createFevex(config: FevexConfig): Fevex {
  return createRuntime(createComposition(config));
}
