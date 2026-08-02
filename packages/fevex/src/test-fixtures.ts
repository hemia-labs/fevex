import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { AgentDefinition } from './agents';
import type { JsonObject, ToolCall } from './core';
import { expect } from 'bun:test';
import type { ModelGateway, ModelInput, ModelResult, ModelStreamEvent } from './models';
import {
  createFevex,
  defineAgent,
  FevexConfigurationError,
  type FevexConfig,
} from './index';

/**
 * Fixtures shared by the runtime test files. Not part of the published
 * surface: it is neither a build entry nor exported from `./testing`.
 */

export type TestSchema<TOutput> = StandardSchemaV1<unknown, TOutput> &
  StandardJSONSchemaV1<unknown, TOutput>;

export const schema = <TOutput>(
  validate: StandardSchemaV1<unknown, TOutput>['~standard']['validate'],
  jsonSchema: JsonObject = { type: 'object' },
): TestSchema<TOutput> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate,
    jsonSchema: {
      input: () => jsonSchema,
      output: () => jsonSchema,
    },
  },
});

export const passthroughSchema = <TOutput>(jsonSchema?: JsonObject): TestSchema<TOutput> =>
  schema((value) => ({ value: value as TOutput }), jsonSchema);

export const agent = (name: string, overrides: Partial<AgentDefinition> = {}) =>
  defineAgent({
    name,
    instructions: 'Answer clearly.',
    ...overrides,
  });

function* toModelEvents(result: ModelResult): Generator<ModelStreamEvent> {
  if (result.output !== undefined) {
    const delta = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    if (delta) yield { type: 'output.delta', delta };
  }
  yield { type: 'completed', result };
}

export function streamFrom(
  generate: (input: ModelInput) => ModelResult | Promise<ModelResult>,
): ModelGateway['stream'] {
  return async function* (input) {
    yield* toModelEvents(await generate(input));
  };
}

export const modelWithOutput = (output: unknown): ModelGateway => ({
  stream: streamFrom(async () => {
    return { output };
  }),
});

export const lookupCall: ToolCall = {
  id: 'call-1',
  name: 'lookup',
  input: { query: 'value' },
};

/** A standard schema with no JSON Schema projection, for transportability tests. */
export const schemaOnly = <TOutput>(
  validate: StandardSchemaV1<unknown, TOutput>['~standard']['validate'],
): StandardSchemaV1<unknown, TOutput> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate,
  },
});

export function getConfigurationError(config: unknown): FevexConfigurationError {
  try {
    createFevex(config as FevexConfig);
  } catch (error) {
    expect(error).toBeInstanceOf(FevexConfigurationError);
    return error as FevexConfigurationError;
  }

  throw new Error('Expected createFevex to reject the configuration');
}
