import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import type { AgentIdentity } from '../../core';
import { FevexRunError } from '../../run-error';
import {
  identityFromClaims,
  type TokenClaims,
  type TokenVerificationOptions,
  type TokenVerifier,
} from '../claims';

/** JOSE algorithms accepted by default. Symmetric algorithms are never allowed. */
export const DEFAULT_JWT_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'] as const;

export interface JwtVerifierOptions extends TokenVerificationOptions {
  /** Remote JWKS endpoint owned by the issuer. */
  jwksUri?: string;
  /** In-memory JWKS for static keys or deterministic tests. */
  jwks?: JSONWebKeySet;
  /**
   * Expected JOSE `typ` header. RFC 9068 uses `at+jwt`; some issuers send
   * `application/at+jwt`. Set to `false` only for issuers that omit it.
   */
  type?: string | false;
  /** Accepted JOSE algorithms. Defaults to {@link DEFAULT_JWT_ALGORITHMS}. */
  algorithms?: readonly string[];
}

/**
 * Verifies RFC 9068 JWT access tokens locally. No network call happens when a
 * static JWKS is supplied; remote key sets are cached by `jose`.
 */
export function createJwtVerifier(options: JwtVerifierOptions): TokenVerifier {
  if (Boolean(options.jwksUri) === Boolean(options.jwks)) {
    throw new TypeError('A JWT verifier requires exactly one of "jwksUri" or "jwks"');
  }
  if (!options.issuer.trim()) throw new TypeError('A JWT verifier requires an issuer');
  if (!options.audience.trim()) throw new TypeError('A JWT verifier requires an audience');

  const keySet: JWTVerifyGetKey = options.jwks
    ? createLocalJWKSet(options.jwks)
    : createRemoteJWKSet(new URL(options.jwksUri!));
  const algorithms = [...(options.algorithms ?? DEFAULT_JWT_ALGORITHMS)];
  const type = options.type ?? 'at+jwt';
  const clockTolerance = options.clockSkewSeconds ?? 60;

  return {
    async verify(token): Promise<AgentIdentity> {
      if (typeof token !== 'string' || !token.trim()) {
        throw new FevexRunError('IDENTITY_INVALID', 'Access token is missing');
      }

      let claims: TokenClaims;
      try {
        const result = await jwtVerify(token, keySet, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms,
          clockTolerance,
          currentDate: new Date(options.now?.() ?? Date.now()),
          ...(type === false ? {} : { typ: type }),
        });
        claims = result.payload;
      } catch (error) {
        throw mapVerificationError(error);
      }

      return identityFromClaims(claims, options);
    },
  };
}

function mapVerificationError(error: unknown): FevexRunError {
  if (error instanceof FevexRunError) return error;
  if (error instanceof errors.JWTExpired) {
    return new FevexRunError('IDENTITY_EXPIRED', 'Access token has expired', undefined, {
      cause: error,
    });
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    const claim = error.claim ? ` "${error.claim}"` : '';
    return new FevexRunError(
      'IDENTITY_INVALID',
      `Access token claim${claim} is not accepted`,
      undefined,
      { cause: error },
    );
  }
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) {
    return new FevexRunError(
      'IDENTITY_UNAVAILABLE',
      'Token verification keys are unavailable',
      undefined,
      { cause: error },
    );
  }
  if (error instanceof errors.JOSEError) {
    return new FevexRunError('IDENTITY_INVALID', 'Access token is invalid', undefined, {
      cause: error,
    });
  }
  return new FevexRunError(
    'IDENTITY_UNAVAILABLE',
    'Token verification is unavailable',
    undefined,
    { cause: error },
  );
}
