import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { JsonObject } from '@fevex/core';

/**
 * Minimal Standard Schema V1 helper with a JSON Schema projection.
 *
 * `@fevex/browser` keeps a single runtime dependency (`@fevex/core`) and does
 * not pull in a validation library. Tool inputs are small and validated by hand;
 * the JSON Schema projection is what the model gateway receives.
 */
export type BrowserSchema<TOutput> = StandardSchemaV1<unknown, TOutput> &
  StandardJSONSchemaV1<unknown, TOutput>;

export function schema<TOutput>(
  validate: StandardSchemaV1<unknown, TOutput>['~standard']['validate'],
  jsonSchema: JsonObject,
): BrowserSchema<TOutput> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fevex-browser',
      validate,
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}

/** Passthrough object schema used for tool outputs (external agent-browser JSON). */
export const jsonObjectOutput: BrowserSchema<JsonObject> = schema<JsonObject>(
  (value) =>
    isRecord(value)
      ? { value }
      : { issues: [{ message: 'Expected an object result' }] },
  { type: 'object', additionalProperties: true },
);

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireString(
  value: unknown,
  field: string,
): StandardSchemaV1.Result<string> {
  if (typeof value !== 'string' || !value.trim()) {
    return { issues: [{ message: `"${field}" must be a non-empty string` }] };
  }
  return { value };
}
