import { IntegrationError, type JsonValue } from '@fevex/core';

const TRUNCATION_NOTE = '\n…[truncated]';

/**
 * Parses `agent-browser` `--json` stdout into a `JsonValue`.
 *
 * On invalid JSON it raises `CONNECTION_REMOTE_ERROR` without echoing the raw
 * stdout, so untrusted or malformed output never reaches the run history. String
 * fields are capped at `maxOutputChars` with a truncation note.
 */
export function parseJson(stdout: string, maxOutputChars: number): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new IntegrationError(
      'CONNECTION_REMOTE_ERROR',
      'remote',
      false,
      'agent-browser returned output that was not valid JSON',
    );
  }
  return truncate(parsed as JsonValue, maxOutputChars);
}

function truncate(value: JsonValue, max: number): JsonValue {
  if (typeof value === 'string') {
    return value.length > max ? value.slice(0, max) + TRUNCATION_NOTE : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncate(item, max));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = truncate(item, max);
    }
    return out;
  }
  return value;
}
