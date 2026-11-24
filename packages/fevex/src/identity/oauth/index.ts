import type { AgentIdentity } from '../../core';
import { FevexRunError } from '../../run-error';
import type { TokenVerifier } from '../claims';

export * from './introspection';
export * from './jwt';

/**
 * Extracts a bearer token from an `Authorization` header.
 * Returns `undefined` when the header is missing or uses another scheme.
 */
export function extractBearerToken(
  authorization: string | null | undefined,
): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(authorization.trim());
  return match?.[1];
}

/** Verifies the bearer credential of an incoming request. */
export async function verifyBearerToken(
  verifier: TokenVerifier,
  authorization: string | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<AgentIdentity> {
  const token = extractBearerToken(authorization);
  if (!token) {
    throw new FevexRunError('IDENTITY_INVALID', 'Bearer token is missing');
  }
  return verifier.verify(token, options);
}
