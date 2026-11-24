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
  payload?: Record<string, unknown>;
} = {}) {
  const { privateKey } = await keyMaterial();
  const header = {
    alg: 'RS256',
    kid: overrides.kid ?? 'key-1',
    ...(overrides.typ === undefined ? {} : { typ: overrides.typ }),
  };
  return new SignJWT({
    scope: 'repo:read billing:read',
    'https://fevex.dev/tenant': 'tenant-a',
    act: { sub: 'researcher' },
    ...overrides.payload,
  })
    .setProtectedHeader(header)
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? 'alice')
    .setIssuedAt(nowSeconds)
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

  test('requires exactly one key source', () => {
    expect(() =>
      createJwtVerifier({ issuer, audience }),
    ).toThrow('exactly one of "jwksUri" or "jwks"');
  });
});

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
