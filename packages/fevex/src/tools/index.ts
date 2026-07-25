import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
  ExecutionContext,
  JsonObject,
  JsonValue,
  RunId,
  ToolCall,
  ToolSpec,
} from '../core';
import type { ExactDefinition } from '../internal/exact-definition';

export type { ToolCall, ToolSpec } from '../core';

export interface ToolExecutionContext {
  runId: RunId;
  toolCallId: string;
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  inputSchema?: StandardSchemaV1<unknown, TInput>;
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  execute(input: TInput, context: ToolExecutionContext): TOutput | Promise<TOutput>;
}

type ToolWithSchemas<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
> = Omit<
  ToolDefinition<
    StandardSchemaV1.InferOutput<TInputSchema>,
    StandardSchemaV1.InferOutput<TOutputSchema>
  >,
  'inputSchema' | 'outputSchema'
> & {
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
};

type ToolWithInputSchema<TInputSchema extends StandardSchemaV1> = Omit<
  ToolDefinition<StandardSchemaV1.InferOutput<TInputSchema>, unknown>,
  'inputSchema'
> & {
  inputSchema: TInputSchema;
};

export function defineTool<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TDefinition extends ToolWithSchemas<TInputSchema, TOutputSchema>,
>(
  tool: ToolWithSchemas<TInputSchema, TOutputSchema>
    & ExactDefinition<TDefinition, ToolWithSchemas<TInputSchema, TOutputSchema>>,
): TDefinition;
export function defineTool<
  TInputSchema extends StandardSchemaV1,
  TDefinition extends ToolWithInputSchema<TInputSchema>,
>(
  tool: ToolWithInputSchema<TInputSchema>
    & ExactDefinition<TDefinition, ToolWithInputSchema<TInputSchema>>,
): TDefinition;
export function defineTool<TDefinition extends ToolDefinition>(
  tool: ToolDefinition & ExactDefinition<TDefinition, ToolDefinition>,
): TDefinition;
export function defineTool(tool: ToolDefinition): ToolDefinition {
  return tool;
}

export function toToolSpec(tool: ToolDefinition, inputSchema?: JsonObject): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    ...(inputSchema === undefined ? {} : { inputSchema }),
  };
}

export type ToolResult = JsonValue;
