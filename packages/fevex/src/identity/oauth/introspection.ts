import type { AgentIdentity } from '../../core';
import { FevexRunError } from '../../run-error';
import {
  identityFromClaims,
  type TokenClaims,
  type TokenVerificationOptions,
  type TokenVerifier,
} from '../claims';

export interface IntrospectionVerifierOptions extends TokenVerificationOptions {
  /** RFC 7662 introspection endpoint. */
  endpoint: string;
  clientId: string;
  clientSecret: string;
  /** Request timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Verifies opaque access tokens through RFC 7662 introspection.
 *
 * The issuer is authoritative on every call, so this backend is suited to
 * issuers that do not emit JWTs or tenants that require immediate revocation.
 * The endpoint is expected to be owned by the configured issuer. Responses that
 * omit `iss` or `aud` are bound to the configured issuer and audience.
 */
export function createIntrospectionVerifier(
  options: IntrospectionVerifierOptions,
): TokenVerifier {
  if (!options.endpoint.trim()) throw new TypeError('Introspection requires an endpoint');
  if (!options.clientId.trim()) throw new TypeError('Introspection requires a client id');
  if (!options.clientSecret) throw new TypeError('Introspection requires a client secret');
  if (!options.issuer.trim()) throw new TypeError('Introspection requires an issuer');
  if (!options.audience.trim()) throw new TypeError('Introspection requires an audience');

  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async verify(token, context): Promise<AgentIdentity> {
      if (typeof token !== 'string' || !token.trim()) {
        throw new FevexRunError('IDENTITY_INVALID', 'Access token is missing');
      }

      const response = await requestIntrospection(token, context?.signal);

      if (response.status === 401 || response.status === 403) {
        throw new FevexRunError(
          'IDENTITY_UNAVAILABLE',
          'Token introspection credentials were rejected',
        );
      }
      if (!response.ok) {
        throw new FevexRunError(
          'IDENTITY_UNAVAILABLE',
          `Token introspection failed with status ${response.status}`,
        );
      }

      let payload: TokenClaims;
      try {
        payload = await response.json() as TokenClaims;
      } catch (error) {
        throw new FevexRunError(
          'IDENTITY_UNAVAILABLE',
          'Token introspection returned an invalid response',
          undefined,
          { cause: error },
        );
      }

      if (payload.active !== true) {
        throw new FevexRunError('IDENTITY_INVALID', 'Access token is not active');
      }

      return identityFromClaims(
        {
          ...payload,
          iss: payload.iss ?? options.issuer,
          aud: payload.aud ?? options.audience,
        },
        options,
      );
    },
  };

  async function requestIntrospection(
    token: string,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, timeoutMs);
    if (externalSignal?.aborted) controller.abort();
    externalSignal?.addEventListener('abort', cancel, { once: true });

    try {
      return await fetchImpl(options.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new FevexRunError(
        'IDENTITY_UNAVAILABLE',
        'Token introspection is unavailable',
        undefined,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', cancel);
    }
  }
}
