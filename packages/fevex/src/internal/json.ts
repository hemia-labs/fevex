import type { JsonObject, JsonValue } from '../core';

const invalidJsonValue = Symbol('invalid-json-value');

function normalizeJsonValue(
  value: unknown,
  seen = new WeakSet<object>(),
): JsonValue | typeof invalidJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : invalidJsonValue;
  }
  if (Array.isArray(value)) {
    const normalized: JsonValue[] = [];

    for (const item of value) {
      const normalizedItem = normalizeJsonValue(item, seen);
      if (normalizedItem === invalidJsonValue) return invalidJsonValue;
      normalized.push(normalizedItem);
    }

    return normalized;
  }
  if (typeof value !== 'object' || value === undefined) {
    return invalidJsonValue;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    return invalidJsonValue;
  }
  if (seen.has(value)) return invalidJsonValue;

  seen.add(value);
  const normalized: JsonObject = {};

  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;

    const normalizedItem = normalizeJsonValue(item, seen);
    if (normalizedItem === invalidJsonValue) return invalidJsonValue;
    Object.defineProperty(normalized, key, {
      value: normalizedItem,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  seen.delete(value);
  return normalized;
}

export function toJsonValue(value: unknown, errorMessage: string): JsonValue {
  let normalized: JsonValue | typeof invalidJsonValue;

  try {
    normalized = normalizeJsonValue(value);
  } catch {
    throw new TypeError(errorMessage);
  }

  if (normalized === invalidJsonValue) {
    throw new TypeError(errorMessage);
  }

  return normalized;
}

export function serializeJsonValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function serializeValue(value: unknown, errorMessage: string): string {
  return serializeJsonValue(toJsonValue(value, errorMessage));
}
