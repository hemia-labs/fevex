import type { ExactDefinition } from '../internal/exact-definition';
import type { RunRequest, RunResult } from '../runtime';

export interface WorkflowStep {
  agent<TInput = unknown, TOutput = unknown>(
    stepId: string,
    agentName: string,
    request: RunRequest<TInput, TOutput>,
  ): Promise<RunResult<TOutput>>;
  parallel<TTasks extends Record<string, () => Promise<unknown>>>(
    stepId: string,
    tasks: TTasks,
  ): Promise<{ [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>> }>;
}

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
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
