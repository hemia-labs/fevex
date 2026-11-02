import type { AgentDefinition } from './agents';
import type { AgentEvent, ExecutionContext, RunId } from './core';
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
import type { ConnectionDefinition, ToolDefinition } from './tools';
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
  memoryStore?: MemoryStore;
  runStore?: RunStore;
  credentialStore?: CredentialStore;
  sandbox?: Sandbox;
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
