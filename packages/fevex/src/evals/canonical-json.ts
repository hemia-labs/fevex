function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

/** Serializes JSON-like data with stable object-key ordering. */
export function serializeCanonical(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2);
}
