import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { SCHEMA_NOT_TRANSPORTABLE, type JsonObject, type JsonValue } from '../core';
import { toJsonValue } from './json';
import { toErrorMessage } from './run-support';

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== 'object' || value === null || !('~standard' in value)) {
    return false;
  }

  const standard = (value as Record<string, unknown>)['~standard'];
  return (
    typeof standard === 'object'
    && standard !== null
    && (standard as Record<string, unknown>).version === 1
    && typeof (standard as Record<string, unknown>).validate === 'function'
  );
}

export function assertStandardSchema(
  value: unknown,
  errorMessage: string,
): asserts value is StandardSchemaV1 {
  if (!isStandardSchema(value)) throw new TypeError(errorMessage);
}

function isStandardJsonSchema(value: unknown): value is StandardJSONSchemaV1 {
  if (!isStandardSchema(value)) return false;

  const jsonSchema = (value['~standard'] as unknown as Record<string, unknown>).jsonSchema;
  return (
    typeof jsonSchema === 'object'
    && jsonSchema !== null
    && typeof (jsonSchema as Record<string, unknown>).input === 'function'
    && typeof (jsonSchema as Record<string, unknown>).output === 'function'
  );
}

function schemaNotTransportable(
  message: string,
): TypeError & { code: typeof SCHEMA_NOT_TRANSPORTABLE } {
  return Object.assign(new TypeError(message), {
    code: SCHEMA_NOT_TRANSPORTABLE as typeof SCHEMA_NOT_TRANSPORTABLE,
  });
}

export function toTransportableSchema(
  schema: StandardSchemaV1,
  direction: 'input' | 'output',
  errorMessage: string,
): JsonObject {
  if (!isStandardJsonSchema(schema)) {
    throw schemaNotTransportable(
      `${errorMessage}: schema does not implement Standard JSON Schema`,
    );
  }

  let rawSchema: unknown;

  try {
    rawSchema = schema['~standard'].jsonSchema[direction]({ target: 'draft-2020-12' });
  } catch (error) {
    throw schemaNotTransportable(`${errorMessage}: ${toErrorMessage(error)}`);
  }

  let jsonSchema: JsonValue;

  try {
    jsonSchema = toJsonValue(
      rawSchema,
      `${errorMessage}: JSON Schema must be JSON-serializable`,
    );
  } catch {
    throw schemaNotTransportable(`${errorMessage}: JSON Schema must be JSON-serializable`);
  }
  if (typeof jsonSchema !== 'object' || jsonSchema === null || Array.isArray(jsonSchema)) {
    throw schemaNotTransportable(`${errorMessage}: JSON Schema must be an object`);
  }

  return jsonSchema;
}

export async function validateSchema<TOutput>(
  schema: StandardSchemaV1<unknown, TOutput>,
  value: unknown,
  errorMessage: string,
): Promise<TOutput> {
  const result = await schema['~standard'].validate(value);

  if (result.issues) {
    const detail = result.issues[0]?.message ?? 'Validation failed';
    throw new TypeError(`${errorMessage}: ${detail}`);
  }

  return result.value;
}
