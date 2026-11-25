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

export interface IntrospectionVerifierOptions extends TokenVerificationOptions {
  /** RFC 7662 introspection endpoint. Must use HTTPS. */
  endpoint: string;
  clientId: string;
  clientSecret: string;
  /** Request and body-read timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Set only when the endpoint is resource-specific and guaranteed to return
   * access tokens. It allows responses without `aud` or `token_type`.
   */
  trustIntrospectionEndpoint?: boolean;
}

/**
 * Verifies opaque access tokens through RFC 7662 introspection.
 *
 * The issuer is authoritative on every call, so this backend is suited to
 * issuers that do not emit JWTs or tenants that require immediate revocation.
 * By default the response must bind the token to the configured resource
 * (`aud`) and identify it as a bearer access token (`token_type`). Set
 * {@link IntrospectionVerifierOptions.trustIntrospectionEndpoint} only when the
 * issuer guarantees both properties at the endpoint.
 */
export function createIntrospectionVerifier(
  options: IntrospectionVerifierOptions,
): TokenVerifier {
  if (!options.endpoint.trim()) throw new TypeError('Introspection requires an endpoint');
  if (!options.clientId.trim()) throw new TypeError('Introspection requires a client id');
  if (!options.clientSecret) throw new TypeError('Introspection requires a client secret');
  if (!options.issuer.trim()) throw new TypeError('Introspection requires an issuer');
  if (!options.audience.trim()) throw new TypeError('Introspection requires an audience');

  const endpoint = secureEndpoint(options.endpoint, 'Introspection endpoint');
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const trustEndpoint = options.trustIntrospectionEndpoint ?? false;

  return {
    async verify(token, context): Promise<AgentIdentity> {
      if (typeof token !== 'string' || !token.trim()) {
        throw new FevexRunError('IDENTITY_INVALID', 'Access token is missing');
      }

      const payload = await introspect(token, context?.signal);
      if (payload.active !== true) {
        throw new FevexRunError('IDENTITY_INVALID', 'Access token is not active');
      }
      assertBindingEvidence(payload);

      return identityFromClaims(
        {
          ...payload,
          iss: payload.iss ?? options.issuer,
          ...(payload.aud === undefined && trustEndpoint
            ? { aud: options.audience }
            : {}),
        },
        options,
      );
    },
  };

  function assertBindingEvidence(payload: TokenClaims): void {
    if (payload.token_type !== undefined) {
      if (
        typeof payload.token_type !== 'string' ||
        payload.token_type.toLowerCase() !== 'bearer'
      ) {
        throw new FevexRunError(
          'IDENTITY_INVALID',
          'Introspection response does not identify a bearer access token',
        );
      }
    } else if (!trustEndpoint) {
      throw new FevexRunError(
        'IDENTITY_INVALID',
        'Introspection response is missing the token type',
      );
    }

    if (payload.aud === undefined && !trustEndpoint) {
      throw new FevexRunError(
        'IDENTITY_INVALID',
        'Introspection response is missing the audience',
      );
    }
  }

  /**
   * Runs the request, the status checks and the body read inside the same
   * timeout and cancellation scope, so a stalled response cannot hang a run.
   */
  async function introspect(
    token: string,
    externalSignal?: AbortSignal,
  ): Promise<TokenClaims & { active: boolean }> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, timeoutMs);
    if (externalSignal?.aborted) controller.abort();
    externalSignal?.addEventListener('abort', cancel, { once: true });

    try {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Basic ${basicCredentials(options.clientId, options.clientSecret)}`,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        throw unavailable('Token introspection is unavailable', error);
      }

      if (response.status === 401 || response.status === 403) {
        await discardResponseBody(response);
        throw new FevexRunError(
          'IDENTITY_UNAVAILABLE',
          'Token introspection credentials were rejected',
        );
      }
      if (!response.ok) {
        const status = response.status;
        await discardResponseBody(response);
        throw unavailable(`Token introspection failed with status ${status}`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await response.text());
      } catch (error) {
        throw unavailable('Token introspection returned an invalid response', error);
      }

      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        typeof (payload as { active?: unknown }).active !== 'boolean'
      ) {
        throw unavailable('Token introspection returned an invalid response');
      }
      return payload as TokenClaims & { active: boolean };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', cancel);
    }
  }
}

/**
 * RFC 6749 §2.3.1 requires form encoding of both values before building the
 * Basic credentials. `encodeURIComponent` is not equivalent for `+` or spaces.
 */
function basicCredentials(clientId: string, clientSecret: string): string {
  return btoa(`${formEncode(clientId)}:${formEncode(clientSecret)}`);
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice('value='.length);
}


function unavailable(message: string, cause?: unknown): FevexRunError {
  return new FevexRunError('IDENTITY_UNAVAILABLE', message, undefined,
    cause === undefined ? undefined : { cause });
}
