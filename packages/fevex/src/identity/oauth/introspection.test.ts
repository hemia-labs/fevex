import { describe, expect, test } from 'bun:test';
import {
  createIntrospectionVerifier,
  type IntrospectionVerifierOptions,
} from './index';

const issuer = 'https://idp.test';
const audience = 'https://fevex.test';
const endpoint = 'https://idp.test/oauth/introspect';
const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
const nowSeconds = Math.floor(nowMs / 1000);

const active = {
  active: true,
  sub: 'alice',
  iss: issuer,
  aud: audience,
  exp: nowSeconds + 300,
  token_type: 'Bearer',
  scope: 'repo:read billing:read',
  'https://fevex.dev/tenant': 'tenant-a',
  act: { sub: 'researcher' },
};

function verifier(
  fetchImpl: typeof fetch,
  overrides: Partial<IntrospectionVerifierOptions> = {},
) {
  return createIntrospectionVerifier({
    endpoint,
    clientId: 'fevex',
    clientSecret: 'secret',
    issuer,
    audience,
    now: () => nowMs,
    fetch: fetchImpl,
    ...overrides,
  });
}

function respond(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('introspection verifier', () => {
  test('maps an active token and authenticates the client', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(active), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const identity = await verifier(fetchImpl).verify('opaque-token');

    expect(identity).toEqual({
      actor: { id: 'alice' },
      agent: { id: 'researcher' },
      tenant: 'tenant-a',
      scopes: ['repo:read', 'billing:read'],
      issuer,
      audience,
      expiresAt: new Date((nowSeconds + 300) * 1000).toISOString(),
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe(endpoint);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.redirect).toBe('error');
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('authorization')).toBe(`Basic ${btoa('fevex:secret')}`);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(String(calls[0]!.init?.body)).toBe('token=opaque-token&token_type_hint=access_token');
  });

  test('form-encodes client credentials before Basic auth', async () => {
    let authorization: string | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization') ?? undefined;
      return new Response(JSON.stringify(active), { status: 200 });
    }) as typeof fetch;

    await verifier(fetchImpl, {
      clientId: 'fevex+client',
      clientSecret: 'a%b+c',
    }).verify('opaque-token');

    expect(authorization).toBe(`Basic ${btoa('fevex%2Bclient:a%25b%2Bc')}`);
  });

  test('rejects inactive tokens', async () => {
    await expect(verifier(respond({ active: false })).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  test('rejects expired tokens', async () => {
    await expect(verifier(respond({ ...active, exp: nowSeconds - 120 })).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_EXPIRED' });
  });

  test('requires expiration and a matching issuer', async () => {
    await expect(verifier(respond({ ...active, exp: undefined })).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
    await expect(verifier(respond({ ...active, iss: 'https://other.test' })).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  test('requires audience and token type by default', async () => {
    const { aud: _aud, ...withoutAudience } = active;
    const { token_type: _type, ...withoutType } = active;
    await expect(verifier(respond(withoutAudience)).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
    await expect(verifier(respond(withoutType)).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  test('can trust an endpoint that guarantees audience and token type', async () => {
    const { aud: _aud, token_type: _type, ...withoutBinding } = active;
    const identity = await verifier(respond(withoutBinding), {
      trustIntrospectionEndpoint: true,
    }).verify('opaque-token');
    expect(identity.issuer).toBe(issuer);
    expect(identity.audience).toBe(audience);
  });

  test('rejects non-bearer token types even when the endpoint is trusted', async () => {
    await expect(verifier(respond({ ...active, token_type: 'refresh_token' }), {
      trustIntrospectionEndpoint: true,
    }).verify('opaque-token')).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  test('fails closed when the issuer is unavailable', async () => {
    await expect(verifier(respond({}, 401)).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
    await expect(verifier(respond({}, 500)).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
    const failing = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    await expect(verifier(failing).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
  });

  test('rejects malformed introspection responses', async () => {
    const invalidJson = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    await expect(verifier(invalidJson).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });

    await expect(verifier(respond(null)).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });

    await expect(verifier(respond({ ...active, active: 'true' })).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
  });

  test('cancels error response bodies', async () => {
    for (const status of [401, 500]) {
      let cancelled = false;
      const body = new ReadableStream({
        cancel() {
          cancelled = true;
        },
      });
      const fetchImpl = (async () => new Response(body, { status })) as unknown as typeof fetch;
      await expect(verifier(fetchImpl).verify('opaque-token'))
        .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
      expect(cancelled).toBe(true);
    }
  });

  test('keeps the timeout active while reading the body', async () => {
    const stalling = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(verifier(stalling, { timeoutMs: 50 }).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
  });

  test('requires HTTPS and allows loopback', () => {
    expect(() => verifier(respond(active), { endpoint: 'http://idp.test/introspect' }))
      .toThrow('must use HTTPS');
    expect(() => verifier(respond(active), { endpoint: 'http://localhost:8080/introspect' }))
      .not.toThrow();
  });

  test('rejects a missing token without calling the issuer', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    await expect(verifier(fetchImpl).verify(' ')).rejects.toMatchObject({
      code: 'IDENTITY_INVALID',
    });
    expect(called).toBe(false);
  });
});
