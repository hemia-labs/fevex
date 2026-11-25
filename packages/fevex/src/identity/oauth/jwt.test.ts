import { describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { createJwtVerifier } from './index';

const issuer = 'https://idp.test';
const audience = 'https://fevex.test';
const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
const nowSeconds = Math.floor(nowMs / 1000);

let material: Promise<{ privateKey: CryptoKey; jwks: JSONWebKeySet }> | undefined;

function keyMaterial() {
  material ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    return {
      privateKey,
      jwks: {
        keys: [{ ...jwk, kid: 'key-1', alg: 'RS256', use: 'sig' }],
      },
    };
  })();
  return material;
}

async function sign(overrides: {
  kid?: string;
  typ?: string;
  issuer?: string;
  audience?: string;
  subject?: string;
  expiration?: number;
  issuedAt?: number | null;
  payload?: Record<string, unknown>;
} = {}) {
  const { privateKey } = await keyMaterial();
  const header = {
    alg: 'RS256',
    kid: overrides.kid ?? 'key-1',
    ...(overrides.typ === undefined ? {} : { typ: overrides.typ }),
  };
  const jwt = new SignJWT({
    client_id: 'fevex-host',
    jti: crypto.randomUUID(),
    scope: 'repo:read billing:read',
    'https://fevex.dev/tenant': 'tenant-a',
    act: { sub: 'researcher' },
    ...overrides.payload,
  })
    .setProtectedHeader(header)
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? 'alice');

  if (overrides.issuedAt !== null) {
    jwt.setIssuedAt(overrides.issuedAt ?? nowSeconds);
  }
  return jwt
    .setExpirationTime(overrides.expiration ?? nowSeconds + 300)
    .sign(privateKey);
}

async function verifier() {
  const { jwks } = await keyMaterial();
  return createJwtVerifier({
    issuer,
    audience,
    jwks,
    now: () => nowMs,
  });
}

describe('JWT access token verifier', () => {
  test('verifies a standard RFC 9068 token', async () => {
    const token = await sign({ typ: 'at+jwt' });
    const identity = await (await verifier()).verify(token);
    expect(identity).toEqual({
      actor: { id: 'alice' },
      agent: { id: 'researcher' },
      tenant: 'tenant-a',
      scopes: ['repo:read', 'billing:read'],
      issuer,
      audience,
      expiresAt: new Date((nowSeconds + 300) * 1000).toISOString(),
    });
  });

  test('rejects a token without the access token type', async () => {
    const token = await sign();
    await expect((await verifier()).verify(token)).rejects.toMatchObject({
      code: 'IDENTITY_INVALID',
    });
  });

  test('allows issuers that omit typ when explicitly configured', async () => {
    const { jwks } = await keyMaterial();
    const token = await sign();
    const identity = await createJwtVerifier({
      issuer,
      audience,
      jwks,
      type: false,
      now: () => nowMs,
    }).verify(token);
    expect(identity.actor).toEqual({ id: 'alice' });
  });

  test('requires the RFC 9068 registered claims', async () => {
    const signer = await verifier();
    await expect(signer.verify(await sign({
      typ: 'at+jwt',
      payload: { client_id: undefined },
    }))).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
    await expect(signer.verify(await sign({
      typ: 'at+jwt',
      payload: { jti: undefined },
    }))).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
    await expect(signer.verify(await sign({
      typ: 'at+jwt',
      issuedAt: null,
    }))).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  test('can relax registered claims for non-compliant issuers', async () => {
    const { jwks } = await keyMaterial();
    const token = await sign({
      typ: 'at+jwt',
      issuedAt: null,
      payload: { client_id: undefined, jti: undefined },
    });
    const identity = await createJwtVerifier({
      issuer,
      audience,
      jwks,
      now: () => nowMs,
      requireRegisteredClaims: false,
    }).verify(token);
    expect(identity.actor).toEqual({ id: 'alice' });
  });

  test('rejects another issuer, audience or subject', async () => {
    const signer = await verifier();
    await expect(signer.verify(await sign({ typ: 'at+jwt', issuer: 'https://other.test' })))
      .rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
    await expect(signer.verify(await sign({ typ: 'at+jwt', audience: 'https://other.test' })))
      .rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
    await expect(signer.verify(await sign({ typ: 'at+jwt', subject: '' })))
      .rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  test('rejects expired tokens', async () => {
    const token = await sign({ typ: 'at+jwt', expiration: nowSeconds - 120 });
    await expect((await verifier()).verify(token)).rejects.toMatchObject({
      code: 'IDENTITY_EXPIRED',
    });
  });

  test('tolerates clock skew', async () => {
    const { jwks } = await keyMaterial();
    const token = await sign({ typ: 'at+jwt', expiration: nowSeconds - 30 });
    const identity = await createJwtVerifier({
      issuer,
      audience,
      jwks,
      now: () => nowMs,
      clockSkewSeconds: 60,
    }).verify(token);
    expect(identity.actor).toEqual({ id: 'alice' });
  });

  test('rejects an unknown kid and unsigned tokens', async () => {
    const signer = await verifier();
    await expect(signer.verify(await sign({ typ: 'at+jwt', kid: 'key-9' })))
      .rejects.toMatchObject({ code: 'IDENTITY_INVALID' });

    const header = base64url(JSON.stringify({ alg: 'none', typ: 'at+jwt' }));
    const payload = base64url(JSON.stringify({
      iss: issuer,
      sub: 'alice',
      aud: audience,
      exp: nowSeconds + 300,
    }));
    await expect(signer.verify(`${header}.${payload}.`)).rejects.toMatchObject({
      code: 'IDENTITY_INVALID',
    });
  });

  test('requires HTTPS for remote JWKS and allows loopback', () => {
    expect(() =>
      createJwtVerifier({ issuer, audience, jwksUri: 'http://idp.test/jwks' }),
    ).toThrow('must use HTTPS');
    expect(() =>
      createJwtVerifier({ issuer, audience, jwksUri: 'http://localhost:8080/jwks' }),
    ).not.toThrow();
    expect(() =>
      createJwtVerifier({ issuer, audience }),
    ).toThrow('exactly one of "jwksUri" or "jwks"');
  });

  test('maps JWKS failures to IDENTITY_UNAVAILABLE', async () => {
    const token = await sign({ typ: 'at+jwt' });
    const failing = createJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://idp.test/jwks',
      fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
      now: () => nowMs,
    });
    await expect(failing.verify(token)).rejects.toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
    });

    const offline = createJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://idp.test/jwks',
      fetch: (async () => {
        throw new TypeError('network down');
      }) as unknown as typeof fetch,
      now: () => nowMs,
    });
    await expect(offline.verify(token)).rejects.toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
    });
  });

  test('cancels JWKS error response bodies', async () => {
    const token = await sign({ typ: 'at+jwt' });
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const verifier = createJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://idp.test/jwks',
      fetch: (async () => new Response(body, { status: 503 })) as unknown as typeof fetch,
      now: () => nowMs,
    });

    await expect(verifier.verify(token)).rejects.toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
    });
    expect(cancelled).toBe(true);
  });

  test('maps malformed JWKS responses to IDENTITY_UNAVAILABLE', async () => {
    const token = await sign({ typ: 'at+jwt' });
    const html = createJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://idp.test/jwks',
      fetch: (async () => new Response('<html>maintenance</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch,
      now: () => nowMs,
    });
    await expect(html.verify(token)).rejects.toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
    });

    const wrongShape = createJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://idp.test/jwks',
      fetch: (async () => new Response(JSON.stringify({ error: 'down' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
      now: () => nowMs,
    });
    await expect(wrongShape.verify(token)).rejects.toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
    });
  });

  test('rejects redirects during JWKS retrieval', async () => {
    const { jwks } = await keyMaterial();
    let redirect: RequestRedirect | undefined;
    const fetching = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const token = await sign({ typ: 'at+jwt' });
    await createJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://idp.test/jwks',
      fetch: fetching,
      now: () => nowMs,
    }).verify(token);
    expect(redirect).toBe('error');
  });
});

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
