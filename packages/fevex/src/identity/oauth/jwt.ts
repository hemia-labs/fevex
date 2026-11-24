import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
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
import { discardResponseBody } from './response';
import { secureEndpoint } from './url';

/** JOSE algorithms accepted by default. Symmetric algorithms are never allowed. */
export const DEFAULT_JWT_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'] as const;

export interface JwtVerifierOptions extends TokenVerificationOptions {
  /** Remote JWKS endpoint owned by the issuer. Must use HTTPS. */
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
  /**
   * Require the RFC 9068 registered claims `client_id`, `iat` and `jti`.
   * Defaults to `true`; disable only for issuers that do not comply.
   */
  requireRegisteredClaims?: boolean;
  /** Injectable fetch used for JWKS retrieval. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
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
    : createRemoteJWKSet(secureEndpoint(options.jwksUri!, 'JWKS URI'), {
        [customFetch]: secureJwksFetch(options.fetch ?? fetch),
      });
  const algorithms = [...(options.algorithms ?? DEFAULT_JWT_ALGORITHMS)];
  const type = options.type ?? 'at+jwt';
  const clockTolerance = options.clockSkewSeconds ?? 60;
  const requireRegisteredClaims = options.requireRegisteredClaims ?? true;

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

      if (requireRegisteredClaims) assertRegisteredClaims(claims);
      return identityFromClaims(claims, options);
    },
  };
}

/**
 * Wraps JWKS retrieval so transport failures never become token failures.
 * Redirects are rejected to keep the configured HTTPS origin authoritative.
 */
function secureJwksFetch(fetchImpl: typeof fetch) {
  return async (
    url: string,
    init: { headers: Headers; method: 'GET'; redirect: 'manual'; signal: AbortSignal },
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error' });
    } catch (error) {
      throw new FevexRunError(
        'IDENTITY_UNAVAILABLE',
        'Token verification keys are unavailable',
        undefined,
        { cause: error },
      );
    }
    if (response.status !== 200) {
      const status = response.status;
      await discardResponseBody(response);
      throw new FevexRunError(
        'IDENTITY_UNAVAILABLE',
        `Token verification keys returned status ${status}`,
      );
    }

    // Parse here so a 200 with HTML or a malformed document is classified as
    // an issuer failure, not as an invalid token by `jose`.
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch (error) {
      throw new FevexRunError(
        'IDENTITY_UNAVAILABLE',
        'Token verification keys returned an invalid response',
        undefined,
        { cause: error },
      );
    }
    if (!isJwks(payload)) {
      throw new FevexRunError(
        'IDENTITY_UNAVAILABLE',
        'Token verification keys returned an invalid response',
      );
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** Enforces the registered claims required by RFC 9068 §2.2. */
function assertRegisteredClaims(claims: TokenClaims): void {
  if (typeof claims.client_id !== 'string' || !claims.client_id.trim()) {
    throw invalid('Token claim "client_id" is missing');
  }
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
    throw invalid('Token claim "iat" is missing');
  }
  if (typeof claims.jti !== 'string' || !claims.jti.trim()) {
    throw invalid('Token claim "jti" is missing');
  }
}

function isJwks(value: unknown): value is { keys: unknown[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = (value as { keys?: unknown }).keys;
  return Array.isArray(keys) &&
    keys.every((key) => key !== null && typeof key === 'object' && !Array.isArray(key));
}

function invalid(message: string): FevexRunError {
  return new FevexRunError('IDENTITY_INVALID', message);
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
