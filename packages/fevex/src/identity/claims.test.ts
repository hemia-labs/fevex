import { describe, expect, test } from 'bun:test';
import { identityFromClaims, type TokenVerificationOptions } from './index';

const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
const exp = Math.floor(nowMs / 1000) + 300;

const options: TokenVerificationOptions = {
  issuer: 'https://idp.test',
  audience: 'https://fevex.test',
  now: () => nowMs,
};

const claims = {
  iss: 'https://idp.test',
  sub: 'alice',
  aud: 'https://fevex.test',
  exp,
  iat: Math.floor(nowMs / 1000) - 10,
  scope: 'repo:read billing:read',
  'https://fevex.dev/tenant': 'tenant-a',
  act: { sub: 'researcher' },
};

describe('identityFromClaims', () => {
  test('maps standard claims to an identity', () => {
    expect(identityFromClaims(claims, options)).toEqual({
      actor: { id: 'alice' },
      agent: { id: 'researcher' },
      tenant: 'tenant-a',
      scopes: ['repo:read', 'billing:read'],
      issuer: 'https://idp.test',
      audience: 'https://fevex.test',
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  });

  test('reads the tenant from tid and scopes from scp', () => {
    const identity = identityFromClaims({
      ...claims,
      'https://fevex.dev/tenant': undefined,
      tid: 'tenant-b',
      scope: undefined,
      scp: ['repo:read', 'repo:read'],
    }, {
      ...options,
      tenantClaims: ['https://fevex.dev/tenant', 'tid'],
    });

    expect(identity.tenant).toBe('tenant-b');
    expect(identity.scopes).toEqual(['repo:read']);
  });

  test('honors custom tenant and agent claims', () => {
    const identity = identityFromClaims({
      ...claims,
      'https://fevex.dev/tenant': undefined,
      organization: 'tenant-c',
      delegated_by: 'planner',
    }, {
      ...options,
      tenantClaims: ['organization'],
      agentClaim: 'delegated_by',
    });

    expect(identity.tenant).toBe('tenant-c');
    expect(identity.agent).toEqual({ id: 'planner' });
  });

  test('accepts a string act claim', () => {
    const identity = identityFromClaims({ ...claims, act: 'planner' }, options);
    expect(identity.agent).toEqual({ id: 'planner' });
  });

  test('requires an exact issuer match', () => {
    expect(() => identityFromClaims({ ...claims, iss: 'https://other.test' }, options))
      .toThrow('Token issuer is not accepted');
  });

  test('requires the audience to contain the resource', () => {
    expect(() => identityFromClaims({ ...claims, aud: 'https://other.test' }, options))
      .toThrow('Token audience is not accepted');
    expect(() =>
      identityFromClaims({ ...claims, aud: ['https://other.test', 'https://fevex.test'] }, options),
    ).not.toThrow();
  });

  test('requires subject and expiration', () => {
    expect(() => identityFromClaims({ ...claims, sub: undefined }, options))
      .toThrow('Token subject is missing');
    expect(() => identityFromClaims({ ...claims, exp: undefined }, options))
      .toThrow('Token expiration is missing');
  });

  test('rejects expired tokens', () => {
    expect(() =>
      identityFromClaims({ ...claims, exp: Math.floor(nowMs / 1000) - 120 }, options),
    ).toThrow(expect.objectContaining({ code: 'IDENTITY_EXPIRED' }));
  });

  test('tolerates clock skew', () => {
    const identity = identityFromClaims(
      { ...claims, exp: Math.floor(nowMs / 1000) - 30 },
      { ...options, clockSkewSeconds: 60 },
    );
    expect(identity.actor).toEqual({ id: 'alice' });
  });

  test('rejects tokens that are not valid yet', () => {
    expect(() =>
      identityFromClaims({ ...claims, nbf: Math.floor(nowMs / 1000) + 300 }, options),
    ).toThrow('Token is not valid yet');
    expect(() =>
      identityFromClaims({ ...claims, iat: Math.floor(nowMs / 1000) + 300 }, options),
    ).toThrow('Token was issued in the future');
  });

  test('treats an empty scope value as no scopes', () => {
    expect(identityFromClaims({ ...claims, scope: '' }, options).scopes).toEqual([]);
    expect(identityFromClaims({ ...claims, scope: undefined, scp: '' }, options).scopes)
      .toEqual([]);
  });

  test('rejects malformed claims', () => {
    expect(() => identityFromClaims({ ...claims, exp: 'tomorrow' }, options))
      .toThrow('Token claim "exp" is malformed');
    expect(() => identityFromClaims({ ...claims, exp: 1e20 }, options))
      .toThrow('Token claim "exp" is malformed');
    expect(() => identityFromClaims({ ...claims, scope: 42 }, options))
      .toThrow('Token claim "scope" is malformed');
    expect(() => identityFromClaims({ ...claims, scope: ['bad scope'] }, options))
      .toThrow('Token claim "scope" is malformed');
    expect(() => identityFromClaims({ ...claims, scope: 'repo:read\tbilling:read' }, options))
      .toThrow('Token claim "scope" is malformed');
    for (const scope of [' repo:read', 'repo:read ', 'repo:read  billing:read']) {
      expect(() => identityFromClaims({ ...claims, scope }, options))
        .toThrow('Token claim "scope" is malformed');
    }
    expect(() => identityFromClaims({ ...claims, scope: undefined, scp: 'repo:read  billing:read' }, options))
      .toThrow('Token claim "scp" is malformed');
    expect(() => identityFromClaims({ ...claims, scope: undefined, scp: [' repo:read'] }, options))
      .toThrow('Token claim "scp" is malformed');
    expect(() => identityFromClaims({ ...claims, act: { id: 'planner' } }, options))
      .toThrow('Token claim "act" is malformed');
    expect(() => identityFromClaims({ ...claims, 'https://fevex.dev/tenant': ' ' }, options))
      .toThrow('Token claim "https://fevex.dev/tenant" is malformed');
  });
});
