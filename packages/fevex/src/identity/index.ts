import type { Actor, AgentIdentity, ExecutionContext } from '../core';
import { FevexRunError } from '../run-error';

/** Returns the identity attached to an execution context. */
export function resolveIdentity(context?: ExecutionContext): AgentIdentity | undefined {
  return context?.identity;
}

/** Returns the actor without requiring the rest of the identity. */
export function actorOf(context?: ExecutionContext): Actor | undefined {
  return context?.identity?.actor;
}

/** Normalizes scopes: trims, drops duplicates and rejects empty entries. */
export function normalizeScopes(scopes: readonly string[]): string[] {
  const normalized = scopes.map((scope) => {
    if (typeof scope !== 'string' || !scope.trim()) {
      throw new TypeError('Identity scopes must be non-empty strings');
    }
    return scope.trim();
  });
  return [...new Set(normalized)];
}

/**
 * Validates the structural shape of an identity. It does not reject expired
 * identities; use {@link assertIdentityActive} for operations.
 */
export function assertIdentity(identity: AgentIdentity): void {
  if (!identity || typeof identity !== 'object') {
    throw new TypeError('Identity must be an object');
  }
  if (typeof identity.actor?.id !== 'string' || !identity.actor.id.trim()) {
    throw new TypeError('Identity actor id must be a non-empty string');
  }
  if (identity.actor.type !== undefined && !identity.actor.type.trim()) {
    throw new TypeError('Identity actor type must be a non-empty string');
  }
  if (identity.agent !== undefined) {
    if (typeof identity.agent.id !== 'string' || !identity.agent.id.trim()) {
      throw new TypeError('Identity agent id must be a non-empty string');
    }
    if (identity.agent.type !== undefined && !identity.agent.type.trim()) {
      throw new TypeError('Identity agent type must be a non-empty string');
    }
  }
  if (identity.tenant !== undefined && !identity.tenant.trim()) {
    throw new TypeError('Identity tenant must be a non-empty string');
  }
  if (identity.issuer !== undefined && !identity.issuer.trim()) {
    throw new TypeError('Identity issuer must be a non-empty string');
  }
  if (identity.audience !== undefined && !identity.audience.trim()) {
    throw new TypeError('Identity audience must be a non-empty string');
  }
  if (!Array.isArray(identity.scopes)) {
    throw new TypeError('Identity scopes must be an array');
  }
  normalizeScopes(identity.scopes);
  if (identity.expiresAt !== undefined && Number.isNaN(Date.parse(identity.expiresAt))) {
    throw new TypeError('Identity expiresAt must be an ISO timestamp');
  }
}

/** True when the identity has an expiry at or before `now`. */
export function isIdentityExpired(identity: AgentIdentity, now = Date.now()): boolean {
  return identity.expiresAt !== undefined && Date.parse(identity.expiresAt) <= now;
}

/** Throws when the identity is expired or structurally invalid. */
export function assertIdentityActive(identity: AgentIdentity, now = Date.now()): void {
  assertIdentity(identity);
  if (isIdentityExpired(identity, now)) {
    throw new FevexRunError('IDENTITY_EXPIRED', 'Identity has expired');
  }
}

export interface CredentialGrant {
  expiresAt?: string;
  scopes?: readonly string[];
  actorId?: string;
  tenantId?: string;
}

/**
 * Fails closed when a credential is expired or is bound to another actor,
 * tenant or scope set.
 */
export function assertCredentialBinding(
  identity: AgentIdentity | undefined,
  credential: CredentialGrant,
  now = Date.now(),
): void {
  if (credential.expiresAt !== undefined) {
    if (Number.isNaN(Date.parse(credential.expiresAt))) {
      throw new FevexRunError('IDENTITY_INVALID', 'Credential expiresAt must be an ISO timestamp');
    }
    if (Date.parse(credential.expiresAt) <= now) {
      throw new FevexRunError('CREDENTIAL_EXPIRED', 'Credential has expired');
    }
  }
  if (credential.actorId !== undefined && credential.actorId !== identity?.actor.id) {
    throw new FevexRunError(
      'CREDENTIAL_IDENTITY_MISMATCH',
      'Credential is bound to another actor',
    );
  }
  if (credential.tenantId !== undefined && credential.tenantId !== identity?.tenant) {
    throw new FevexRunError(
      'CREDENTIAL_IDENTITY_MISMATCH',
      'Credential is bound to another tenant',
    );
  }
  if (credential.scopes !== undefined) {
    if (!isScopeSubset(credential.scopes, identity?.scopes ?? [])) {
      throw new FevexRunError(
        'CREDENTIAL_SCOPE_DENIED',
        'Credential requires scopes that the identity does not hold',
      );
    }
  }
}

export function hasScope(identity: AgentIdentity, scope: string): boolean {
  return identity.scopes.includes(scope);
}

/** True when every child scope exists in the parent identity. */
export function isScopeSubset(
  child: readonly string[],
  parent: readonly string[],
): boolean {
  const allowed = new Set(parent);
  return child.every((scope) => allowed.has(scope));
}

/**
 * Produces a delegated identity for a child run.
 *
 * Invariants:
 * - the actor cannot change;
 * - the tenant cannot change;
 * - issuer and audience cannot change;
 * - child scopes must be a subset of parent scopes;
 * - the expiry can only be shortened.
 */
export function delegateIdentity(
  parent: AgentIdentity,
  child?: AgentIdentity,
): AgentIdentity {
  assertIdentity(parent);
  assertIdentityActive(parent);
  if (!child) return parent;
  assertIdentity(child);
  assertIdentityActive(child);

  if (child.actor.id !== parent.actor.id) {
    throw new FevexRunError('POLICY_DENIED', 'A delegated identity cannot change the actor');
  }
  if (child.tenant !== undefined && child.tenant !== parent.tenant) {
    throw new FevexRunError('POLICY_DENIED', 'A delegated identity cannot change the tenant');
  }
  if (child.issuer !== undefined && child.issuer !== parent.issuer) {
    throw new FevexRunError('POLICY_DENIED', 'A delegated identity cannot change the issuer');
  }
  if (child.audience !== undefined && child.audience !== parent.audience) {
    throw new FevexRunError('POLICY_DENIED', 'A delegated identity cannot change the audience');
  }

  const scopes = normalizeScopes(child.scopes);
  if (!isScopeSubset(scopes, parent.scopes)) {
    throw new FevexRunError(
      'POLICY_DENIED',
      'A delegated identity cannot add scopes that the parent does not hold',
    );
  }

  const expiresAt = earliestExpiry(parent.expiresAt, child.expiresAt);
  if (
    child.expiresAt !== undefined &&
    parent.expiresAt !== undefined &&
    Date.parse(child.expiresAt) > Date.parse(parent.expiresAt)
  ) {
    throw new FevexRunError(
      'POLICY_DENIED',
      'A delegated identity cannot extend the parent expiry',
    );
  }

  return {
    actor: parent.actor,
    ...(child.agent ?? parent.agent ? { agent: child.agent ?? parent.agent } : {}),
    ...(parent.tenant === undefined ? {} : { tenant: parent.tenant }),
    scopes,
    ...(parent.issuer === undefined ? {} : { issuer: parent.issuer }),
    ...(parent.audience === undefined ? {} : { audience: parent.audience }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function earliestExpiry(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Date.parse(second) < Date.parse(first) ? second : first;
}
