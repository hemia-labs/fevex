import type { JsonObject, JsonValue } from '../core';

export const FEVEX_JSON_SCHEMA_PROFILE_VERSION = '1';

export interface FevexJsonSchemaProfileLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxProperties?: number;
}

export interface FevexJsonSchemaProfileOptions {
  rootDocument?: JsonObject;
  requireRootObject?: boolean;
  limits?: FevexJsonSchemaProfileLimits;
}

export interface FevexJsonSchemaValidator {
  schema: JsonObject;
  validate(value: unknown, path?: string): JsonValue;
}

const DEFAULT_LIMITS = {
  maxBytes: 64_000,
  maxDepth: 32,
  maxNodes: 1_000,
  maxProperties: 200,
};

const KEYWORDS = new Set([
  '$defs',
  '$ref',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'default',
  'description',
  'enum',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'oneOf',
  'properties',
  'required',
  'title',
  'type',
]);

const DEFERRED = new Set([
  'dependentSchemas',
  'format',
  'if',
  'not',
  'pattern',
  'then',
  'else',
  'unevaluatedProperties',
]);

export function validateFevexJsonSchemaProfile(
  schema: JsonObject,
  options: FevexJsonSchemaProfileOptions = {},
): JsonObject {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const text = JSON.stringify(schema);
  if (text.length > limits.maxBytes) {
    throw new TypeError(`JSON Schema exceeds maxBytes limit of ${limits.maxBytes}`);
  }
  const rootDocument = options.rootDocument ?? schema;
  const stats = { nodes: 0 };
  visitSchema(schema, rootDocument, options.requireRootObject ?? false, limits, stats, [], 0);
  return schema;
}

export function compileFevexJsonSchema(
  schema: JsonObject,
  options: FevexJsonSchemaProfileOptions = {},
): FevexJsonSchemaValidator {
  validateFevexJsonSchemaProfile(schema, options);
  const rootDocument = options.rootDocument ?? schema;
  return {
    schema,
    validate(value, path = '$') {
      validateValue(schema, rootDocument, value, path, []);
      return toJsonValue(value, `${path} must be JSON-serializable`);
    },
  };
}

function visitSchema(
  schema: JsonObject,
  rootDocument: JsonObject,
  requireRootObject: boolean,
  limits: Required<FevexJsonSchemaProfileLimits>,
  stats: { nodes: number },
  refs: string[],
  depth: number,
): void {
  stats.nodes += 1;
  if (stats.nodes > limits.maxNodes) {
    throw new TypeError(`JSON Schema exceeds maxNodes limit of ${limits.maxNodes}`);
  }
  if (depth > limits.maxDepth) {
    throw new TypeError(`JSON Schema exceeds maxDepth limit of ${limits.maxDepth}`);
  }
  for (const key of Object.keys(schema)) {
    if (DEFERRED.has(key) || !KEYWORDS.has(key)) {
      throw new TypeError(`JSON Schema keyword "${key}" is not supported`);
    }
  }
  if (requireRootObject && schema.type !== 'object' && !schema.$ref && !schema.allOf) {
    throw new TypeError('Tool input JSON Schema root must be object');
  }
  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    if (!ref.startsWith('#/')) throw new TypeError(`Remote JSON Schema ref "${ref}" is not supported`);
    if (refs.includes(ref)) throw new TypeError(`JSON Schema ref cycle detected at "${ref}"`);
    visitSchema(resolveRef(rootDocument, ref), rootDocument, false, limits, stats, [...refs, ref], depth + 1);
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new TypeError('JSON Schema properties must be an object');
    const entries = Object.entries(schema.properties);
    if (entries.length > limits.maxProperties) {
      throw new TypeError(`JSON Schema exceeds maxProperties limit of ${limits.maxProperties}`);
    }
    for (const [, child] of entries) {
      if (!isRecord(child)) throw new TypeError('JSON Schema property schemas must be objects');
      visitSchema(child, rootDocument, false, limits, stats, refs, depth + 1);
    }
  }
  for (const key of ['$defs'] as const) {
    if (schema[key] === undefined) continue;
    if (!isRecord(schema[key])) throw new TypeError(`JSON Schema ${key} must be an object`);
    for (const child of Object.values(schema[key])) {
      if (!isRecord(child)) throw new TypeError(`JSON Schema ${key} entries must be objects`);
      visitSchema(child, rootDocument, false, limits, stats, refs, depth + 1);
    }
  }
  if (schema.items !== undefined) {
    if (!isRecord(schema.items)) throw new TypeError('JSON Schema items must be an object');
    visitSchema(schema.items, rootDocument, false, limits, stats, refs, depth + 1);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key])) throw new TypeError(`JSON Schema ${key} must be an array`);
    for (const child of schema[key]) {
      if (!isRecord(child)) throw new TypeError(`JSON Schema ${key} entries must be objects`);
      visitSchema(child, rootDocument, false, limits, stats, refs, depth + 1);
    }
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    if (schema.additionalProperties !== true && !isRecord(schema.additionalProperties)) {
      throw new TypeError('JSON Schema additionalProperties must be boolean or object');
    }
    if (isRecord(schema.additionalProperties)) {
      visitSchema(schema.additionalProperties, rootDocument, false, limits, stats, refs, depth + 1);
    }
  }
}

function validateValue(
  schema: JsonObject,
  rootDocument: JsonObject,
  value: unknown,
  path: string,
  refs: string[],
): void {
  if (typeof schema.$ref === 'string') {
    if (refs.includes(schema.$ref)) throw new TypeError(`JSON Schema ref cycle detected at "${schema.$ref}"`);
    return validateValue(resolveRef(rootDocument, schema.$ref), rootDocument, value, path, [...refs, schema.$ref]);
  }
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) validateValue(child as JsonObject, rootDocument, value, path, refs);
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((child) => passes(child as JsonObject, rootDocument, value, path, refs))) {
      throw new TypeError(`${path} must match anyOf`);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const count = schema.oneOf.filter((child) => passes(child as JsonObject, rootDocument, value, path, refs)).length;
    if (count !== 1) throw new TypeError(`${path} must match exactly one oneOf schema`);
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    throw new TypeError(`${path} must equal const`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    throw new TypeError(`${path} must be one of enum`);
  }
  validateType(schema.type, value, path);
  if (schema.type === 'object' || isRecord(value)) validateObject(schema, rootDocument, value, path, refs);
  if (schema.type === 'array' || Array.isArray(value)) validateArray(schema, rootDocument, value, path, refs);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) throw new TypeError(`${path} is shorter than minLength`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) throw new TypeError(`${path} is longer than maxLength`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new TypeError(`${path} is below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) throw new TypeError(`${path} is above maximum`);
  }
}

function validateObject(schema: JsonObject, rootDocument: JsonObject, value: unknown, path: string, refs: string[]) {
  if (!isRecord(value)) return;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === 'string' && !(key in value)) throw new TypeError(`${path}.${key} is required`);
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, child] of Object.entries(properties)) {
    if (key in value && isRecord(child)) validateValue(child, rootDocument, value[key], `${path}.${key}`, refs);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) throw new TypeError(`${path}.${key} is not allowed`);
    }
  } else if (isRecord(schema.additionalProperties)) {
    for (const [key, item] of Object.entries(value)) {
      if (!(key in properties)) validateValue(schema.additionalProperties, rootDocument, item, `${path}.${key}`, refs);
    }
  }
}

function validateArray(schema: JsonObject, rootDocument: JsonObject, value: unknown, path: string, refs: string[]) {
  if (!Array.isArray(value)) return;
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) throw new TypeError(`${path} has fewer than minItems`);
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new TypeError(`${path} has more than maxItems`);
  if (isRecord(schema.items)) {
    value.forEach((item, index) => validateValue(schema.items as JsonObject, rootDocument, item, `${path}[${index}]`, refs));
  }
}

function validateType(type: unknown, value: unknown, path: string) {
  if (type === undefined) return;
  const types = Array.isArray(type) ? type : [type];
  const ok = types.some((item) => {
    if (item === 'array') return Array.isArray(value);
    if (item === 'integer') return Number.isInteger(value);
    if (item === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (item === 'object') return isRecord(value);
    if (item === 'null') return value === null;
    return typeof value === item;
  });
  if (!ok) throw new TypeError(`${path} must be ${types.join(' or ')}`);
}

function passes(schema: JsonObject, rootDocument: JsonObject, value: unknown, path: string, refs: string[]): boolean {
  try {
    validateValue(schema, rootDocument, value, path, refs);
    return true;
  } catch {
    return false;
  }
}

function resolveRef(rootDocument: JsonObject, ref: string): JsonObject {
  const segments = ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = rootDocument;
  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) throw new TypeError(`JSON Schema ref "${ref}" cannot be resolved`);
    current = current[segment];
  }
  if (!isRecord(current)) throw new TypeError(`JSON Schema ref "${ref}" must resolve to an object`);
  return current;
}

function toJsonValue(value: unknown, message: string): JsonValue {
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    if (cloned === undefined) throw new TypeError(message);
    return cloned;
  } catch {
    throw new TypeError(message);
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
