import { describe, expect, test } from 'bun:test';
import { toJsonValue } from './json';

describe('JSON normalization', () => {
  test('preserves special JSON keys as ordinary own properties', () => {
    const source = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"safe":true},"prototype":"value","nested":{"__proto__":"nested"},"items":[{"__proto__":"array"}]}',
    );
    const normalized = toJsonValue(source, 'invalid') as Record<string, unknown>;
    const nested = normalized.nested as Record<string, unknown>;
    const arrayItem = (normalized.items as Array<Record<string, unknown>>)[0]!;

    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(normalized, '__proto__')).toMatchObject({
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(Object.hasOwn(normalized, 'constructor')).toBe(true);
    expect(Object.hasOwn(normalized, 'prototype')).toBe(true);
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(Object.hasOwn(arrayItem, '__proto__')).toBe(true);
    expect(JSON.stringify(normalized)).toBe(JSON.stringify(source));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test('continues rejecting values outside strict JSON', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    class CustomValue {}

    for (const value of [
      undefined,
      () => {},
      Symbol('value'),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Date(),
      new Map(),
      new Set(),
      new CustomValue(),
      cyclic,
    ]) {
      expect(() => toJsonValue(value, 'invalid')).toThrow('invalid');
    }
  });
});
