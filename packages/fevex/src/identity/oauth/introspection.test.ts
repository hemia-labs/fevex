import { describe, expect, test } from 'bun:test';
import { createIntrospectionVerifier } from './index';

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
  scope: 'repo:read billing:read',
  'https://fevex.dev/tenant': 'tenant-a',
  act: { sub: 'researcher' },
};

function verifier(fetchImpl: typeof fetch) {
  return createIntrospectionVerifier({
    endpoint,
    clientId: 'fevex',
    clientSecret: 'secret',
    issuer,
    audience,
    now: () => nowMs,
    fetch: fetchImpl,
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
    expect(calls[0]!.input).toBe(endpoint);
    expect(calls[0]!.init?.method).toBe('POST');
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('authorization')).toBe(`Basic ${btoa('fevex:secret')}`);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(String(calls[0]!.init?.body)).toBe('token=opaque-token&token_type_hint=access_token');
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

  test('falls back to the configured issuer and audience', async () => {
    const { iss: _iss, aud: _aud, ...withoutBinding } = active;
    const identity = await verifier(respond(withoutBinding)).verify('opaque-token');
    expect(identity.issuer).toBe(issuer);
    expect(identity.audience).toBe(audience);
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

  test('rejects an invalid introspection response', async () => {
    const invalid = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    await expect(verifier(invalid).verify('opaque-token'))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
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
