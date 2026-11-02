import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecutionContext, RunRecord } from '@fevex/core';
import type { FevexHttpAccess } from '@fevex/core/http';

const DEMO_CONTEXT: ExecutionContext = {
  actor: { id: 'demo-user' },
  attributes: { tenantId: 'demo' },
};

// ponytail: fixed demo tokens; replace with your identity provider.
const DEMO_TOKENS = new Map<string, ExecutionContext>([
  ['alice-token', { actor: { id: 'alice' }, attributes: { tenantId: 'tenant-a' } }],
  ['bob-token', { actor: { id: 'bob' }, attributes: { tenantId: 'tenant-b' } }],
]);

export function demoAuthEnabled(): boolean {
  return process.env.FEVEX_DEMO_AUTH === '1';
}

/**
 * Resolves a demo bearer token. Anonymous requests resolve to `demo-user`
 * only when demo auth is explicitly enabled for the playground.
 */
export function resolveDemoContext(
  authorization: string | null | undefined,
  allowAnonymousDemo = false,
): ExecutionContext | undefined {
  if (!authorization) return allowAnonymousDemo ? DEMO_CONTEXT : undefined;
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return token ? DEMO_TOKENS.get(token) : undefined;
}

interface OwnershipSnapshot {
  runs: Record<string, string>;
  sessions: Record<string, string>;
}

/**
 * Demo ownership store. Pass a filename to persist owners across restarts;
 * replace it with your own database-backed store for real tenants.
 */
// ponytail: JSON sidecar; use your database for multi-process deployments.
export class DemoAuthorization {
  readonly #runOwners = new Map<string, string>();
  readonly #sessionOwners = new Map<string, string>();
  readonly #filename: string | undefined;

  constructor(filename?: string) {
    this.#filename = filename;
    this.#load();
  }

  claim(run: Pick<RunRecord, 'id' | 'sessionId'>, context?: ExecutionContext): void {
    const owner = ownerKey(context);
    if (!owner) return;
    const sessionOwner = this.#sessionOwners.get(run.sessionId);
    if (sessionOwner && sessionOwner !== owner) {
      throw new Error('Session is owned by another actor');
    }
    this.#runOwners.set(run.id, owner);
    this.#sessionOwners.set(run.sessionId, owner);
    this.#save();
  }

  authorize(access: FevexHttpAccess): boolean {
    const owner = ownerKey(access.context);
    if (!owner) return false;
    if (access.action === 'start') {
      return access.sessionId ? this.#sessionOwners.get(access.sessionId) === owner : true;
    }
    return this.#runOwners.get(access.runId) === owner;
  }

  #load(): void {
    if (!this.#filename) return;
    let raw: string;
    try {
      raw = readFileSync(this.#filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const snapshot = JSON.parse(raw) as Partial<OwnershipSnapshot> | null;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error(`Invalid ownership file "${this.#filename}"`);
    }
    for (const [runId, owner] of Object.entries(snapshot.runs ?? {})) {
      if (typeof owner === 'string') this.#runOwners.set(runId, owner);
    }
    for (const [sessionId, owner] of Object.entries(snapshot.sessions ?? {})) {
      if (typeof owner === 'string') this.#sessionOwners.set(sessionId, owner);
    }
  }

  #save(): void {
    if (!this.#filename) return;
    mkdirSync(dirname(this.#filename), { recursive: true });
    const temporary = `${this.#filename}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      runs: Object.fromEntries(this.#runOwners),
      sessions: Object.fromEntries(this.#sessionOwners),
    }), { mode: 0o600 });
    renameSync(temporary, this.#filename);
  }
}

function ownerKey(context?: ExecutionContext): string | undefined {
  const actorId = context?.actor?.id;
  const tenantId = context?.attributes?.tenantId;
  if (!actorId || typeof tenantId !== 'string' || !tenantId) return undefined;
  // Key by tenant and actor. Use the tenant alone if runs are shared within it.
  return JSON.stringify([tenantId, actorId]);
}
