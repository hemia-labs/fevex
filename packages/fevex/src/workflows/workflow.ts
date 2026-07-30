import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ExactDefinition } from '../internal/exact-definition';
import type { AgentLimits } from '../agents';
import type { ExecutionContext, JsonObject, JsonValue, RunId } from '../core';
import type { RunRequest, RunResult, SessionId } from '../runtime';

/** Context shared with workflow steps and compensation handlers. */
export interface WorkflowStepContext {
  runId: RunId;
  sessionId: SessionId;
  stepId: string;
  context?: ExecutionContext;
  signal: AbortSignal;
}

export interface WorkflowStepOptions<TResult = unknown> {
  compensate?(result: TResult, context: WorkflowStepContext): void | Promise<void>;
  /** Metadata persisted with the step and its lifecycle events. */
  metadata?: JsonObject;
}

export type WorkflowAgentResult<TOutput = unknown> = Omit<RunResult<TOutput>, 'events'>;

export interface WorkflowEventResult<TPayload extends JsonValue = JsonValue> {
  payload?: TPayload;
  actor?: NonNullable<ExecutionContext['actor']>;
  receivedAt: string;
}

export interface WorkflowEventDefinition<TPayload extends JsonValue = JsonValue> {
  payloadSchema?: StandardSchemaV1<unknown, TPayload>;
  requireActor?: boolean;
}

export interface WorkflowStep {
  agent<TInput = unknown, TOutput = unknown>(
    stepId: string,
    agentName: string,
    request: RunRequest<TInput, TOutput>,
    options?: WorkflowStepOptions<WorkflowAgentResult<TOutput>>,
  ): Promise<WorkflowAgentResult<TOutput>>;
  parallel<TTasks extends Record<string, () => Promise<unknown>>>(
    stepId: string,
    tasks: TTasks,
    options?: WorkflowStepOptions<{ [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>> }>,
  ): Promise<{ [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>> }>;
  waitUntil(stepId: string, resumeAt: string | Date): Promise<void>;
  waitForEvent<TPayload extends JsonValue = JsonValue>(
    stepId: string,
    eventName: string,
  ): Promise<WorkflowEventResult<TPayload>>;
}

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  inputSchema?: StandardSchemaV1<unknown, TInput>;
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  events?: Record<string, WorkflowEventDefinition>;
  limits?: AgentLimits;
  /**
   * Semantic version of `run`, defaults to `"1"`.
   *
   * A paused run only resumes against the same version. Bump it whenever a
   * change to `run` — or to anything `run` calls — would make replaying an
   * in-flight run incorrect: reordered steps, a reused `stepId` that now means
   * something else, or a changed business rule.
   *
   * The runtime cannot infer this. Hashing the source of `run` would break on
   * every minified redeploy while still missing changes in the functions `run`
   * closes over, so the decision belongs to the author.
   */
  version?: string;
  run(step: WorkflowStep, input: TInput): TOutput | Promise<TOutput>;
}

export function defineWorkflow<T extends WorkflowDefinition>(
  workflow: ExactDefinition<T, WorkflowDefinition>,
): T {
  return workflow;
}
