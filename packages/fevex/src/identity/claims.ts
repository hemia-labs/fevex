import type { Actor, AgentIdentity } from '../core';
import { FevexRunError } from '../run-error';
import { assertIdentity } from './contract';
import { isScopeList, isScopeToken, normalizeScopes } from './scopes';

/** Claims read from an RFC 9068 access token or an RFC 7662 introspection response. */
export type TokenClaims = Record<string, unknown>;

/** Options shared by every token verification backend. */
export interface TokenVerificationOptions {
  /** Issuer accepted for this resource. Compared exactly with `iss`. */
  issuer: string;
  /** Resource identifier of this host. Must appear in `aud`. */
  audience: string;
  /**
   * Claims that may carry the tenant. The first non-empty string wins.
   * Defaults to the namespaced FEVEX claim and OIDC's `tid`.
   */
  tenantClaims?: readonly string[];
  /** Claim that carries the delegated agent. Defaults to RFC 8693 `act`. */
  agentClaim?: string;
  /** Clock skew tolerated for `exp`, `nbf` and `iat`. Defaults to 60 seconds. */
  clockSkewSeconds?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Verifies a credential and returns the identity it represents. */
export interface TokenVerifier {
  verify(token: string, options?: { signal?: AbortSignal }): Promise<AgentIdentity>;
}

export const DEFAULT_TENANT_CLAIMS = ['https://fevex.dev/tenant', 'tid'] as const;
export const DEFAULT_AGENT_CLAIM = 'act';
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;

/**
 * Builds an `AgentIdentity` from verified token claims.
 *
 * This function is pure: it does not verify signatures. It enforces the
 * claims required to bind an identity to this resource:
 *
 * - `iss` must match the configured issuer;
 * - `aud` must contain the configured resource;
 * - `sub` is the actor;
 * - `exp` is mandatory;
 * - `nbf` and `iat` cannot be in the future beyond the tolerated skew;
 * - `scope` (space-delimited string, RFC 9068) or `scp` (Azure
 *   compatibility) becomes the scope set; an empty string is treated as no
 *   scopes for issuer compatibility;
 * - RFC 8693 `act.sub` becomes the delegated agent;
 * - the tenant comes from a namespaced claim, then `tid`.
 */
export function identityFromClaims(
  claims: TokenClaims,
  options: TokenVerificationOptions,
): AgentIdentity {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw invalid('Token claims are malformed');
  }
  if (!options.issuer.trim()) {
    throw new TypeError('Token verification requires an issuer');
  }
  if (!options.audience.trim()) {
    throw new TypeError('Token verification requires an audience');
  }

  if (claims.iss !== options.issuer) {
    throw invalid('Token issuer is not accepted');
  }
  if (!audienceMatches(claims.aud, options.audience)) {
    throw invalid('Token audience is not accepted');
  }

  const subject = claims.sub;
  if (typeof subject !== 'string' || !subject.trim()) {
    throw invalid('Token subject is missing');
  }

  const expiresAt = numericDate(claims.exp, 'exp');
  if (expiresAt === undefined) {
    throw invalid('Token expiration is missing');
  }

  const now = options.now?.() ?? Date.now();
  const skew = (options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS) * 1000;

  if (expiresAt * 1000 <= now - skew) {
    throw new FevexRunError('IDENTITY_EXPIRED', 'Access token has expired');
  }

  const notBefore = numericDate(claims.nbf, 'nbf');
  if (notBefore !== undefined && notBefore * 1000 > now + skew) {
    throw invalid('Token is not valid yet');
  }
  const issuedAt = numericDate(claims.iat, 'iat');
  if (issuedAt !== undefined && issuedAt * 1000 > now + skew) {
    throw invalid('Token was issued in the future');
  }

  const agent = readAgent(claims, options.agentClaim ?? DEFAULT_AGENT_CLAIM);
  const tenant = readTenant(claims, options.tenantClaims ?? DEFAULT_TENANT_CLAIMS);

  const identity: AgentIdentity = {
    actor: { id: subject.trim() },
    ...(agent === undefined ? {} : { agent }),
    ...(tenant === undefined ? {} : { tenant }),
    scopes: readScopes(claims),
    issuer: options.issuer,
    audience: options.audience,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };

  assertIdentity(identity);
  return identity;
}

function audienceMatches(value: unknown, audience: string): boolean {
  if (typeof value === 'string') return value === audience;
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === 'string') && value.includes(audience);
  }
  return false;
}

/** Highest NumericDate that `Date` can represent, in seconds. */
const MAX_NUMERIC_DATE = 8_640_000_000_000;

/** Returns a finite NumericDate or `undefined` when the claim is absent. */
function numericDate(value: unknown, claim: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_NUMERIC_DATE
  ) {
    throw invalid(`Token claim "${claim}" is malformed`);
  }
  return value;
}

function readScopes(claims: TokenClaims): string[] {
  const scope = claims.scope;
  if (scope !== undefined) {
    if (typeof scope !== 'string') throw invalid('Token claim "scope" is malformed');
    if (scope === '') return [];
    // Validate the raw value: RFC 6749 §3.3 forbids leading, trailing or
    // repeated spaces. Splitting first would silently accept them.
    if (!isScopeList(scope)) throw invalid('Token claim "scope" is malformed');
    return normalizeScopes(scope.split(' '));
  }

  // `scp` is not part of RFC 9068. It is accepted for Azure compatibility.
  const scp = claims.scp;
  if (scp !== undefined) {
    if (typeof scp === 'string') {
      if (scp === '') return [];
      if (!isScopeList(scp)) throw invalid('Token claim "scp" is malformed');
      return normalizeScopes(scp.split(' '));
    }
    if (Array.isArray(scp)) {
      if (!scp.every((entry) => isScopeToken(entry))) {
        throw invalid('Token claim "scp" is malformed');
      }
      return normalizeScopes(scp);
    }
    throw invalid('Token claim "scp" is malformed');
  }
  return [];
}

function readAgent(claims: TokenClaims, claim: string): Actor | undefined {
  const value = claims[claim];
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim()) {
    return { id: value.trim() };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const subject = (value as { sub?: unknown }).sub;
    if (typeof subject === 'string' && subject.trim()) {
      return { id: subject.trim() };
    }
  }
  throw invalid(`Token claim "${claim}" is malformed`);
}

function readTenant(
  claims: TokenClaims,
  tenantClaims: readonly string[],
): string | undefined {
  for (const claim of tenantClaims) {
    const value = claims[claim];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) {
      throw invalid(`Token claim "${claim}" is malformed`);
    }
    return value.trim();
  }
  return undefined;
}

function invalid(message: string): FevexRunError {
  return new FevexRunError('IDENTITY_INVALID', message);
}
