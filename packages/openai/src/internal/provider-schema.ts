import type { JsonObject } from '@fevex/core';

const supportedTypes = new Set([
  'string',
  'number',
  'boolean',
  'integer',
  'object',
  'array',
  'null',
]);
const supportedFormats = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);
const supportedKeywords = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'format',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
]);

interface ValidationState {
  propertyCount: number;
  enumCount: number;
  stringLength: number;
}

export function findOpenAISchemaIssue(schema: JsonObject): string | undefined {
  if (schema.type !== 'object' || schema.anyOf !== undefined) {
    return '$: root must be an object and must not use anyOf';
  }

  const state: ValidationState = {
    propertyCount: 0,
    enumCount: 0,
    stringLength: 0,
  };
  const issue = visitSchema(schema, '$', 0, state);
  if (issue) return issue;
  if (state.propertyCount > 5_000) {
    return '$: schema exceeds OpenAI limit of 5000 object properties';
  }
  if (state.enumCount > 1_000) {
    return '$: schema exceeds OpenAI limit of 1000 enum values';
  }
  if (state.stringLength > 120_000) {
    return '$: schema exceeds OpenAI limit of 120000 schema string characters';
  }
  return undefined;
}

function visitSchema(
  schema: unknown,
  path: string,
  objectDepth: number,
  state: ValidationState,
): string | undefined {
  if (!isRecord(schema)) return `${path}: schema must be an object`;

  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) {
      return `${path}.${keyword}: keyword is not supported by OpenAI strict schemas`;
    }
  }

  if (schema.$ref !== undefined && typeof schema.$ref !== 'string') {
    return `${path}.$ref: must be a string`;
  }

  const typeIssue = validateType(schema.type, path);
  if (typeIssue) return typeIssue;

  const types = typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type) ? schema.type : [];
  const isObject = types.includes('object');
  const isArray = types.includes('array');
  const isString = types.includes('string');
  const isNumeric = types.includes('number') || types.includes('integer');
  const nextObjectDepth = isObject ? objectDepth + 1 : objectDepth;

  if (nextObjectDepth > 10) {
    return `${path}: schema exceeds OpenAI limit of 10 object nesting levels`;
  }
  if (
    !isObject
    && hasAny(schema, ['properties', 'required', 'additionalProperties'])
  ) {
    return `${path}: object keywords require type "object"`;
  }
  if (!isArray && hasAny(schema, ['items', 'minItems', 'maxItems'])) {
    return `${path}: array keywords require type "array"`;
  }
  if (!isString && hasAny(schema, ['pattern', 'format'])) {
    return `${path}: string keywords require type "string"`;
  }
  if (
    !isNumeric
    && hasAny(schema, [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
    ])
  ) {
    return `${path}: numeric keywords require type "number" or "integer"`;
  }

  if (isObject) {
    if (!isRecord(schema.properties)) {
      return `${path}.properties: must be an object`;
    }
    if (schema.additionalProperties !== false) {
      return `${path}.additionalProperties: must be false`;
    }

    const propertyNames = Object.keys(schema.properties);
    const required = schema.required;
    if (
      !Array.isArray(required)
      || required.some((name) => typeof name !== 'string')
      || required.length !== propertyNames.length
      || propertyNames.some((name) => !required.includes(name))
    ) {
      return `${path}.required: must contain every property exactly once`;
    }

    state.propertyCount += propertyNames.length;
    state.stringLength += propertyNames.reduce((total, name) => total + name.length, 0);
    for (const name of propertyNames) {
      const issue = visitSchema(
        schema.properties[name],
        `${path}.properties.${name}`,
        nextObjectDepth,
        state,
      );
      if (issue) return issue;
    }
  }

  if (isArray) {
    if (!isRecord(schema.items)) return `${path}.items: must be a schema object`;
    const issue = visitSchema(schema.items, `${path}.items`, objectDepth, state);
    if (issue) return issue;
  }

  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      return `${path}.anyOf: must be a non-empty array`;
    }
    for (let index = 0; index < schema.anyOf.length; index += 1) {
      const issue = visitSchema(schema.anyOf[index], `${path}.anyOf[${index}]`, objectDepth, state);
      if (issue) return issue;
    }
  }

  const definitions = schema.$defs;
  if (definitions !== undefined) {
    if (!isRecord(definitions)) return `${path}.$defs: must be an object`;
    const names = Object.keys(definitions);
    state.stringLength += names.reduce((total, name) => total + name.length, 0);
    for (const name of names) {
      const issue = visitSchema(definitions[name], `${path}.$defs.${name}`, objectDepth, state);
      if (issue) return issue;
    }
  }

  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum)
      || schema.enum.some((value) => !isJsonPrimitive(value))
    ) {
      return `${path}.enum: must contain only JSON primitive values`;
    }
    state.enumCount += schema.enum.length;
    const enumStringLength = schema.enum.reduce(
      (total, value) => total + (typeof value === 'string' ? value.length : 0),
      0,
    );
    state.stringLength += enumStringLength;
    if (schema.enum.length > 250 && enumStringLength > 15_000) {
      return `${path}.enum: exceeds OpenAI limit of 15000 characters for large enums`;
    }
  }

  if (schema.const !== undefined && !isJsonPrimitive(schema.const)) {
    return `${path}.const: must be a JSON primitive`;
  }
  if (typeof schema.const === 'string') state.stringLength += schema.const.length;

  if (schema.pattern !== undefined && typeof schema.pattern !== 'string') {
    return `${path}.pattern: must be a string`;
  }
  if (
    schema.format !== undefined
    && (typeof schema.format !== 'string' || !supportedFormats.has(schema.format))
  ) {
    return `${path}.format: format "${String(schema.format)}" is not supported by OpenAI`;
  }

  for (const keyword of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
  ]) {
    if (
      schema[keyword] !== undefined
      && (typeof schema[keyword] !== 'number' || !Number.isFinite(schema[keyword]))
    ) {
      return `${path}.${keyword}: must be a number`;
    }
  }
  for (const keyword of ['minItems', 'maxItems']) {
    if (
      schema[keyword] !== undefined
      && (
        typeof schema[keyword] !== 'number'
        || !Number.isInteger(schema[keyword])
        || schema[keyword] < 0
      )
    ) {
      return `${path}.${keyword}: must be a non-negative integer`;
    }
  }

  return undefined;
}

function validateType(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return supportedTypes.has(value)
      ? undefined
      : `${path}.type: type "${value}" is not supported by OpenAI`;
  }
  if (
    Array.isArray(value)
    && value.length === 2
    && value.filter((type) => type === 'null').length === 1
    && value.every((type) => typeof type === 'string' && supportedTypes.has(type))
  ) {
    return undefined;
  }
  return `${path}.type: must be a supported type or a nullable two-type union`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAny(schema: Record<string, unknown>, keywords: string[]): boolean {
  return keywords.some((keyword) => schema[keyword] !== undefined);
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}
