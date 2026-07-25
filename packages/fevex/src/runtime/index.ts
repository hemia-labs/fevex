import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AgentEvent, ExecutionContext } from '../core';
import type { ModelUsage } from '../models';

export interface RunRequest<TInput = unknown, TOutput = unknown> {
  input: TInput;
  context?: ExecutionContext;
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  signal?: AbortSignal;
}

export interface RunResult<TOutput = unknown> {
  output: TOutput;
  events?: AgentEvent[];
  usage?: ModelUsage;
}
