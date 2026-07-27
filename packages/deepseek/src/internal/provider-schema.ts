import type { JsonObject } from '@fevex/core';

const supportedTypes = new Set([
  'object',
  'string',
  'number',
  'integer',
  'boolean',
  'array',
]);
const supportedFormats = new Set(['email', 'hostname', 'ipv4', 'ipv6', 'uuid']);
const supportedKeywords = new Set([
  '$schema',
  '$id',
  '$ref',
  '$def',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
  'format',
  'pattern',
  'const',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);

export function findDeepSeekToolSchemaIssue(schema: JsonObject): string | undefined {
  if (schema.type !== 'object' || schema.anyOf !== undefined) {
    return '$: tool input root must be an object';
  }
  return visitSchema(schema, '$');
}

function visitSchema(schema: unknown, path: string): string | undefined {
  if (!isRecord(schema)) return `${path}: schema must be an object`;

  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) {
      return `${path}.${keyword}: keyword is not supported by DeepSeek strict tools`;
    }
  }

  if (schema.$ref !== undefined && typeof schema.$ref !== 'string') {
    return `${path}.$ref: must be a string`;
  }
  if (
    schema.type !== undefined
    && (typeof schema.type !== 'string' || !supportedTypes.has(schema.type))
  ) {
    return `${path}.type: type "${String(schema.type)}" is not supported by DeepSeek`;
  }
  const isObject = schema.type === 'object';
  const isArray = schema.type === 'array';
  const isString = schema.type === 'string';
  const isNumeric = schema.type === 'number' || schema.type === 'integer';

  if (
    !isObject
    && hasAny(schema, ['properties', 'required', 'additionalProperties'])
  ) {
    return `${path}: object keywords require type "object"`;
  }
  if (!isArray && schema.items !== undefined) {
    return `${path}: items requires type "array"`;
  }
  if (!isString && hasAny(schema, ['pattern', 'format'])) {
    return `${path}: string keywords require type "string"`;
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

    for (const name of propertyNames) {
      const issue = visitSchema(schema.properties[name], `${path}.properties.${name}`);
      if (issue) return issue;
    }
  }

  if (isArray) {
    if (!isRecord(schema.items)) return `${path}.items: must be a schema object`;
    const issue = visitSchema(schema.items, `${path}.items`);
    if (issue) return issue;
  }

  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      return `${path}.anyOf: must be a non-empty array`;
    }
    for (let index = 0; index < schema.anyOf.length; index += 1) {
      const issue = visitSchema(schema.anyOf[index], `${path}.anyOf[${index}]`);
      if (issue) return issue;
    }
  }

  const definitions = schema.$def;
  if (definitions !== undefined) {
    if (!isRecord(definitions)) return `${path}.$def: must be an object`;
    for (const [name, definition] of Object.entries(definitions)) {
      const issue = visitSchema(definition, `${path}.$def.${name}`);
      if (issue) return issue;
    }
  }

  if (
    schema.enum !== undefined
    && (
      !Array.isArray(schema.enum)
      || schema.enum.some((value) => !isJsonPrimitive(value))
    )
  ) {
    return `${path}.enum: must contain only JSON primitive values`;
  }
  if (
    schema.format !== undefined
    && (typeof schema.format !== 'string' || !supportedFormats.has(schema.format))
  ) {
    return `${path}.format: format "${String(schema.format)}" is not supported by DeepSeek`;
  }
  if (schema.pattern !== undefined && typeof schema.pattern !== 'string') {
    return `${path}.pattern: must be a string`;
  }

  for (const keyword of [
    'const',
    'default',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
  ]) {
    if (
      schema[keyword] !== undefined
      && (
        !isNumeric
        || typeof schema[keyword] !== 'number'
        || !Number.isFinite(schema[keyword])
      )
    ) {
      return `${path}.${keyword}: is supported only as a numeric constraint`;
    }
  }

  return undefined;
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
