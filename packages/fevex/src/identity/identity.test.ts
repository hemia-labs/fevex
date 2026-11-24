import { describe, expect, test } from 'bun:test';
import type { AgentIdentity } from '../core';
import {
  assertCredentialBinding,
  assertIdentity,
  assertIdentityActive,
  delegateIdentity,
  hasScope,
  isIdentityExpired,
  isScopeSubset,
  normalizeScopes,
} from './index';

const base: AgentIdentity = {
  actor: { id: 'alice' },
  agent: { id: 'researcher' },
  tenant: 'tenant-a',
  scopes: ['repo:read', 'web:read'],
  issuer: 'https://issuer.test',
  audience: 'fevex',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

describe('identity contract', () => {
  test('normalizes scopes', () => {
    expect(normalizeScopes([' read ', 'read', 'write'])).toEqual(['read', 'write']);
    expect(() => normalizeScopes([''])).toThrow(TypeError);
    expect(() => normalizeScopes(['read write'])).toThrow(TypeError);
    expect(() => normalizeScopes(['read"write'])).toThrow(TypeError);
    expect(() => normalizeScopes(['read\\write'])).toThrow(TypeError);
    expect(normalizeScopes(['repo:read', 'billing.read'])).toEqual(['repo:read', 'billing.read']);
  });

  test('validates structure and expiry', () => {
    expect(() => assertIdentity(base)).not.toThrow();
    expect(() => assertIdentity({ ...base, actor: { id: '' } })).toThrow(TypeError);
    expect(() => assertIdentity({ ...base, tenant: '' })).toThrow(TypeError);
    expect(() => assertIdentity({ ...base, expiresAt: 'yesterday' })).toThrow(TypeError);
    expect(isIdentityExpired(base, Date.parse('2030-01-01T00:00:00.000Z'))).toBe(true);
    expect(() => assertIdentityActive(base, Date.parse('2030-01-01T00:00:00.000Z'))).toThrow(
      'Identity has expired',
    );
  });

  test('checks scopes', () => {
    expect(hasScope(base, 'repo:read')).toBe(true);
    expect(hasScope(base, 'admin')).toBe(false);
    expect(isScopeSubset(['repo:read'], base.scopes)).toBe(true);
    expect(isScopeSubset(['admin'], base.scopes)).toBe(false);
  });

  test('delegates a narrower identity', () => {
    const child = delegateIdentity(base, {
      actor: { id: 'alice' },
      agent: { id: 'worker' },
      tenant: 'tenant-a',
      scopes: ['repo:read'],
      issuer: 'https://issuer.test',
      audience: 'fevex',
      expiresAt: '2029-01-01T00:00:00.000Z',
    });

    expect(child).toMatchObject({
      actor: { id: 'alice' },
      agent: { id: 'worker' },
      tenant: 'tenant-a',
      scopes: ['repo:read'],
      issuer: 'https://issuer.test',
      audience: 'fevex',
      expiresAt: '2029-01-01T00:00:00.000Z',
    });
  });

  test('rejects actor, tenant and scope escalation', () => {
    expect(() =>
      delegateIdentity(base, { ...base, actor: { id: 'bob' } }),
    ).toThrow('cannot change the actor');
    expect(() =>
      delegateIdentity(base, { ...base, tenant: 'tenant-b' }),
    ).toThrow('cannot change the tenant');
    expect(() =>
      delegateIdentity(base, { ...base, scopes: ['admin'] }),
    ).toThrow('cannot add scopes');
    expect(() =>
      delegateIdentity(base, { ...base, expiresAt: '2031-01-01T00:00:00.000Z' }),
    ).toThrow('cannot extend the parent expiry');
  });

  test('binds credentials to actor, tenant, scopes and expiry', () => {
    expect(() =>
      assertCredentialBinding(base, {}),
    ).not.toThrow();
    expect(() =>
      assertCredentialBinding(base, { actorId: 'bob' }),
    ).toThrow('another actor');
    expect(() =>
      assertCredentialBinding(base, { tenantId: 'tenant-b' }),
    ).toThrow('another tenant');
    expect(() =>
      assertCredentialBinding(base, { scopes: ['admin'] }),
    ).toThrow('scopes');
    expect(() =>
      assertCredentialBinding(base, {
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ).toThrow('expired');
  });
});
