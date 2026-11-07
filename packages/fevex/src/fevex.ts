import type { AgentDefinition, ContextBudget, ToolSearchOptions } from './agents';
import type { ArtifactStore } from './artifacts';
import type { AgentEvent, ExecutionContext, RunId } from './core';
import { createComposition } from './internal/configuration';
import { createRuntime } from './internal/runtime';
import type { ContextProvider, MemoryStore } from './knowledge';
import type { ModelGateway } from './models';
import type { ObservabilityOptions, ObservabilityStats } from './observability';
import type { PolicyDefinition } from './policies';
import type { Sandbox } from './sandbox';
import type {
  AgentRun,
  ContextCompactionOptions,
  ContextCompactionStats,
  CredentialStore,
  ListEventsOptions,
  PurgeRunsOptions,
  PurgeRunsResult,
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
import type { ConnectionDefinition, ToolDefinition, ToolEmbeddingCache } from './tools';
import type { WorkflowDefinition } from './workflows';

export interface FevexAdmissionRequest {
  kind: 'agent' | 'workflow' | 'team';
  name: string;
  request: RunRequest;
  activeRuns: number;
  activeTenantRuns: number;
}

/** Optional host-level admission controls applied before a top-level run starts. */
export interface FevexAdmission {
  /** Maximum concurrent top-level runs in this runtime. */
  maxActiveRuns?: number;
  /** Maximum concurrent top-level runs for one tenant. */
  maxActiveRunsPerTenant?: number;
  /** Defaults to a non-empty `context.attributes.tenantId` string. */
  tenantKey?: (context?: ExecutionContext) => string | undefined;
  /** Custom admission check, called after the built-in limits. */
  authorize?: (request: FevexAdmissionRequest) => boolean | Promise<boolean>;
}

export interface FevexShutdownOptions {
  /**
   * Maximum time to wait for active runs before cancelling them. Defaults to
   * 30 seconds. Use `0` to cancel immediately. If the deadline expires,
   * shutdown allows up to 5 additional seconds for forced cancellation and the
   * final trace flush.
   */
  timeoutMs?: number;
}

export interface FevexShutdownResult {
  /** Runs that were still active when the grace period expired. */
  cancelledRunIds: RunId[];
  /** True when the grace deadline expired before all active runs finished. */
  timedOut: boolean;
  /** Error surfaced while flushing pending traces, if any. */
  exportError?: unknown;
  /** Observability counters after the shutdown flush. */
  observability: ObservabilityStats;
}

export interface FevexLimits {
  /**
   * Maximum non-control events persisted for one run. Control events such as
   * pause, resume, approval and terminal transitions are always persisted.
   */
  maxEventsPerRun?: number;
}

/** Provider-neutral definitions and adapters used to create one Fevex runtime. */
export interface FevexConfig {
  models: Record<string, ModelGateway>;
  agents: AgentDefinition[];
  workflows?: WorkflowDefinition[];
  teams?: TeamDefinition[];
  tools?: ToolDefinition[];
  connections?: ConnectionDefinition[];
  contextProviders?: ContextProvider[];
  /** Default context budget for agents that do not declare one. */
  contextBudget?: ContextBudget;
  /** Optional context compactor and token estimator. */
  compaction?: ContextCompactionOptions;
  /** Default on-demand tool search for agents that do not declare one. */
  toolSearch?: ToolSearchOptions;
  /** Optional durable cache for semantic tool embeddings. */
  toolSearchCache?: ToolEmbeddingCache;
  memoryStore?: MemoryStore;
  runStore?: RunStore;
  credentialStore?: CredentialStore;
  sandbox?: Sandbox;
  /** Optional artifact store exposed to tools as `context.artifacts`. */
  artifacts?: ArtifactStore;
  policies?: PolicyDefinition[];
  onEvent?: (event: AgentEvent) => void;
  observability?: ObservabilityOptions;
  admission?: FevexAdmission;
  limits?: FevexLimits;
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
  purgeRuns(options?: PurgeRunsOptions): Promise<PurgeRunsResult>;
  compactSession(sessionId: SessionId, summary: string): Promise<Session>;
  /** Waits for queued exports and rejects with failures accumulated since the previous flush. */
  flushObservability(options?: { timeoutMs?: number }): Promise<void>;
  /** Cumulative trace export counters for this runtime. */
  getObservabilityStats(): ObservabilityStats;
  /** Cumulative context compaction counters for this runtime. */
  getCompactionStats(): ContextCompactionStats;
  /**
   * Stops admitting new work, drains or cancels active runs, and flushes trace
   * exports. The host still owns closing its stores and external adapters.
   */
  shutdown(options?: FevexShutdownOptions): Promise<FevexShutdownResult>;
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
