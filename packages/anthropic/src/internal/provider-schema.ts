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
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);
const supportedKeywords = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
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
  'allOf',
  'default',
  'format',
  'pattern',
  'minItems',
]);

export interface AnthropicSchemaLimits {
  optionalParameters: number;
  unionParameters: number;
}

type Definitions = Record<string, unknown>;

export interface AnthropicSchemaOptions {
  requireObjectRoot?: boolean;
}

export function findAnthropicSchemaIssue(
  schema: JsonObject,
  limits: AnthropicSchemaLimits = { optionalParameters: 0, unionParameters: 0 },
  options: AnthropicSchemaOptions = {},
): string | undefined {
  if (
    options.requireObjectRoot !== false
    && (schema.type !== 'object' || schema.anyOf !== undefined || schema.allOf !== undefined)
  ) {
    return '$: root must be an object';
  }

  const definitions = readDefinitions(schema, '$');
  if (typeof definitions === 'string') return definitions;
  const cycle = findDefinitionCycle(definitions);
  if (cycle) return `$: recursive $ref is not supported (${cycle})`;

  const issue = visitSchema(schema, '$', definitions, [], limits);
  if (issue) return issue;
  if (limits.optionalParameters > 24) {
    return '$: schema exceeds Anthropic limit of 24 optional parameters';
  }
  if (limits.unionParameters > 16) {
    return '$: schema exceeds Anthropic limit of 16 union-type parameters';
  }
  return undefined;
}

function visitSchema(
  schema: unknown,
  path: string,
  definitions: Definitions,
  refStack: string[],
  limits: AnthropicSchemaLimits,
): string | undefined {
  if (!isRecord(schema)) return `${path}: schema must be an object`;

  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) {
      return `${path}.${keyword}: keyword is not supported by Anthropic strict schemas`;
    }
  }

  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== 'string') return `${path}.$ref: must be a string`;
    const name = definitionName(schema.$ref);
    if (!name) {
      return `${path}.$ref: only local #/$defs/<name> references are supported`;
    }
    if (!(name in definitions)) return `${path}.$ref: unknown definition "${name}"`;
    if (refStack.includes(name)) {
      return `${path}.$ref: recursive schemas are not supported`;
    }
  }

  const typeIssue = validateType(schema.type, path, limits);
  if (typeIssue) return typeIssue;

  const types = typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type) ? schema.type : [];
  const isObject = types.includes('object');
  const isArray = types.includes('array');
  const isString = types.includes('string');

  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      return `${path}.anyOf: must be a non-empty array`;
    }
    limits.unionParameters += 1;
    for (let index = 0; index < schema.anyOf.length; index += 1) {
      const issue = visitSchema(
        schema.anyOf[index],
        `${path}.anyOf[${index}]`,
        definitions,
        refStack,
        limits,
      );
      if (issue) return issue;
    }
  }

  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) {
      return `${path}.allOf: must be a non-empty array`;
    }
    for (let index = 0; index < schema.allOf.length; index += 1) {
      const branch = schema.allOf[index];
      if (isRecord(branch) && branch.$ref !== undefined) {
        return `${path}.allOf[${index}]: allOf with $ref is not supported by Anthropic`;
      }
      const issue = visitSchema(
        branch,
        `${path}.allOf[${index}]`,
        definitions,
        refStack,
        limits,
      );
      if (issue) return issue;
    }
  }

  if (!isObject && hasAny(schema, ['properties', 'required', 'additionalProperties'])) {
    return `${path}: object keywords require type "object"`;
  }
  if (!isArray && hasAny(schema, ['items', 'minItems'])) {
    return `${path}: array keywords require type "array"`;
  }
  if (!isString && hasAny(schema, ['pattern', 'format'])) {
    return `${path}: string keywords require type "string"`;
  }

  if (isObject) {
    if (schema.properties !== undefined && !isRecord(schema.properties)) {
      return `${path}.properties: must be an object`;
    }
    if (schema.additionalProperties !== false) {
      return `${path}.additionalProperties: must be false`;
    }

    const properties = schema.properties === undefined ? {} : schema.properties;
    const propertyNames = Object.keys(properties);
    const required = schema.required;
    if (required !== undefined) {
      if (
        !Array.isArray(required)
        || required.some((name) => typeof name !== 'string')
        || new Set(required).size !== required.length
        || required.some((name) => !propertyNames.includes(name))
      ) {
        return `${path}.required: must contain unique property names`;
      }
    }
    limits.optionalParameters += propertyNames.length - (required?.length ?? 0);

    for (const name of propertyNames) {
      const issue = visitSchema(
        properties[name],
        `${path}.properties.${name}`,
        definitions,
        refStack,
        limits,
      );
      if (issue) return issue;
    }
  }

  if (isArray) {
    if (!isRecord(schema.items)) return `${path}.items: must be a schema object`;
    if (schema.minItems !== undefined && schema.minItems !== 0 && schema.minItems !== 1) {
      return `${path}.minItems: Anthropic only supports 0 or 1`;
    }
    const issue = visitSchema(schema.items, `${path}.items`, definitions, refStack, limits);
    if (issue) return issue;
  }

  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum)
      || schema.enum.length === 0
      || schema.enum.some((value) => !isJsonPrimitive(value))
    ) {
      return `${path}.enum: must contain only JSON primitive values`;
    }
  }

  for (const keyword of ['const', 'default']) {
    if (schema[keyword] !== undefined && !isJsonValue(schema[keyword])) {
      return `${path}.${keyword}: must be a JSON value`;
    }
  }

  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') return `${path}.pattern: must be a string`;
    const patternIssue = findPatternIssue(schema.pattern);
    if (patternIssue) return `${path}.pattern: ${patternIssue}`;
  }
  if (
    schema.format !== undefined
    && (typeof schema.format !== 'string' || !supportedFormats.has(schema.format))
  ) {
    return `${path}.format: format "${String(schema.format)}" is not supported by Anthropic`;
  }

  for (const keyword of ['$defs', 'definitions']) {
    const definitionsValue = schema[keyword];
    if (definitionsValue === undefined) continue;
    if (!isRecord(definitionsValue)) {
      return `${path}.${keyword}: must be an object`;
    }
    for (const [name, definition] of Object.entries(definitionsValue)) {
      const issue = visitSchema(
        definition,
        `${path}.${keyword}.${name}`,
        definitions,
        [...refStack, name],
        limits,
      );
      if (issue) return issue;
    }
  }

  return undefined;
}

function validateType(
  value: unknown,
  path: string,
  limits: AnthropicSchemaLimits,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return supportedTypes.has(value)
      ? undefined
      : `${path}.type: type "${value}" is not supported by Anthropic`;
  }
  if (
    Array.isArray(value)
    && value.length > 0
    && value.every((type) => typeof type === 'string' && supportedTypes.has(type))
    && new Set(value).size === value.length
  ) {
    limits.unionParameters += 1;
    return undefined;
  }
  return `${path}.type: must be a supported type or a non-empty array of unique types`;
}

function readDefinitions(schema: JsonObject, path: string): Definitions | string {
  const definitions: Definitions = {};
  for (const keyword of ['$defs', 'definitions']) {
    const value = schema[keyword];
    if (value === undefined) continue;
    if (!isRecord(value)) return `${path}.${keyword}: must be an object`;
    for (const [name, definition] of Object.entries(value)) {
      if (name in definitions) return `${path}.${keyword}.${name}: duplicate definition`;
      definitions[name] = definition;
    }
  }
  return definitions;
}

function findDefinitionCycle(definitions: Definitions): string | undefined {
  const graph = new Map<string, string[]>();
  for (const [name, definition] of Object.entries(definitions)) {
    const refs = new Set<string>();
    collectDefinitionRefs(definition, definitions, refs);
    graph.set(name, [...refs]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (name: string): string | undefined => {
    if (visited.has(name)) return undefined;
    if (visiting.has(name)) {
      const start = stack.indexOf(name);
      return [...stack.slice(start), name].join(' -> ');
    }
    visiting.add(name);
    stack.push(name);
    for (const next of graph.get(name) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(name);
    visited.add(name);
    return undefined;
  };

  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return undefined;
}

function collectDefinitionRefs(
  value: unknown,
  definitions: Definitions,
  refs: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDefinitionRefs(item, definitions, refs);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.$ref === 'string') {
    const name = definitionName(value.$ref);
    if (name && name in definitions) refs.add(name);
  }
  for (const item of Object.values(value)) {
    collectDefinitionRefs(item, definitions, refs);
  }
}

function definitionName(ref: string): string | undefined {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match?.[1]) return undefined;
  return match[1].replace(/~1/g, '/').replace(/~0/g, '~');
}

function findPatternIssue(pattern: string): string | undefined {
  if (/\\[1-9]/.test(pattern)) return 'backreferences are not supported';
  if (/\(\?[=!<]/.test(pattern)) {
    return 'lookahead and lookbehind assertions are not supported';
  }
  if (/\\[bB]/.test(pattern)) return 'word boundaries are not supported';
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

function isJsonValue(value: unknown, seen = new Set<unknown>()): boolean {
  if (isJsonPrimitive(value)) return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  if (!isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}
