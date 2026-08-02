import { createHash } from 'node:crypto';
import type { RunId } from '@fevex/core';

/**
 * Derives an opaque, stable session name from a run id.
 *
 * The session name is passed to `agent-browser` as `--session` so every tool
 * call in the same run reuses one browser session (cookies, tabs, daemon). It
 * must never leak actor, tenant, URL or credential data, so it is a one-way
 * hash of the run id rather than the id itself.
 */
export function sessionName(runId: RunId): string {
  const digest = createHash('sha256').update(String(runId)).digest('hex');
  return `fevex-${digest.slice(0, 24)}`;
}

export function sessionArgs(runId: RunId): string[] {
  return ['--session', sessionName(runId)];
}
