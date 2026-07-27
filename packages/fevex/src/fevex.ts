import type { AgentDefinition } from './agents';
import type { AgentEvent, RunId } from './core';
import { createComposition } from './internal/configuration';
import { createRuntime } from './internal/runtime';
import type { ModelGateway } from './models';
import type { ObservabilityOptions } from './observability';
import type { PolicyDefinition } from './policies';
import type {
  AgentRun,
  CredentialStore,
  ListEventsOptions,
  ResumeRunResolution,
  RunRequest,
  RunResult,
  RunStore,
  Session,
  SessionId,
} from './runtime';
import type { ToolDefinition } from './tools';

export interface FevexConfig {
  models: Record<string, ModelGateway>;
  agents: AgentDefinition[];
  tools?: ToolDefinition[];
  runStore?: RunStore;
  credentialStore?: CredentialStore;
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
  getRun<TOutput = unknown>(runId: RunId): Promise<AgentRun<TOutput> | undefined>;
  listEvents(runId: RunId, options?: ListEventsOptions): Promise<AgentEvent[]>;
  cancelRun(runId: RunId): Promise<boolean>;
  resumeRun<TOutput = unknown>(
    runId: RunId,
    resolution: ResumeRunResolution,
  ): Promise<AgentRun<TOutput>>;
  compactSession(sessionId: SessionId, summary: string): Promise<Session>;
  flushObservability(): Promise<void>;
}

export function createFevex(config: FevexConfig): Fevex {
  return createRuntime(createComposition(config));
}
