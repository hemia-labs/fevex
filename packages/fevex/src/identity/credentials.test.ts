import { describe, expect, test } from 'bun:test';
import type { AgentIdentity } from '../core';
import { createFevex, defineAgent, defineTool } from '../index';
import type { CredentialStore } from '../runtime';
import { fakeModel } from '../testing';

const alice: AgentIdentity = {
  actor: { id: 'alice' },
  tenant: 'tenant-a',
  scopes: ['read'],
};

function appWith(credentialStore: CredentialStore) {
  return createFevex({
    models: {
      default: fakeModel(
        { toolCalls: [{ id: 'call-1', name: 'lookup', input: {} }] },
        { output: 'done' },
      ),
    },
    agents: [defineAgent({ name: 'assistant', instructions: 'Work.', tools: ['lookup'] })],
    tools: [
      defineTool({
        name: 'lookup',
        credentials: ['api-key'],
        async execute(_input, context) {
          await context.getCredential('api-key');
          return 'ok';
        },
      }),
    ],
    credentialStore,
  });
}

describe('credential identity binding', () => {
  test('accepts a credential bound to the actor and scopes', async () => {
    const app = appWith({
      async resolve() {
        return { value: 'secret', actorId: 'alice', scopes: ['read'] };
      },
    });
    const result = await app.runAgent('assistant', {
      input: 'go',
      context: { identity: alice },
    });
    expect(result.output).toBe('done');
  });

  test('rejects a credential bound to another actor', async () => {
    const app = appWith({
      async resolve() {
        return { value: 'secret', actorId: 'bob' };
      },
    });
    await expect(app.runAgent('assistant', {
      input: 'go',
      context: { identity: alice },
    })).rejects.toMatchObject({ code: 'CREDENTIAL_IDENTITY_MISMATCH' });
  });

  test('rejects a credential bound to another tenant', async () => {
    const app = appWith({
      async resolve() {
        return { value: 'secret', tenantId: 'tenant-b' };
      },
    });
    await expect(app.runAgent('assistant', {
      input: 'go',
      context: { identity: alice },
    })).rejects.toMatchObject({ code: 'CREDENTIAL_IDENTITY_MISMATCH' });
  });

  test('rejects scopes the identity does not hold', async () => {
    const app = appWith({
      async resolve() {
        return { value: 'secret', scopes: ['admin'] };
      },
    });
    await expect(app.runAgent('assistant', {
      input: 'go',
      context: { identity: alice },
    })).rejects.toMatchObject({ code: 'CREDENTIAL_SCOPE_DENIED' });
  });

  test('refreshes an expired credential', async () => {
    let refreshed = 0;
    const app = appWith({
      async resolve() {
        return { value: 'old', expiresAt: '2020-01-01T00:00:00.000Z' };
      },
      async refresh() {
        refreshed += 1;
        return { value: 'new', actorId: 'alice', scopes: ['read'] };
      },
    });
    const result = await app.runAgent('assistant', {
      input: 'go',
      context: { identity: alice },
    });
    expect(result.output).toBe('done');
    expect(refreshed).toBe(1);
  });

  test('fails closed when an expired credential cannot be refreshed', async () => {
    const app = appWith({
      async resolve() {
        return { value: 'old', expiresAt: '2020-01-01T00:00:00.000Z' };
      },
    });
    await expect(app.runAgent('assistant', {
      input: 'go',
      context: { identity: alice },
    })).rejects.toMatchObject({ code: 'CREDENTIAL_EXPIRED' });
  });

  test('rejects an expired execution identity before the run starts', async () => {
    const app = appWith({
      async resolve() {
        return { value: 'secret' };
      },
    });
    await expect(app.runAgent('assistant', {
      input: 'go',
      context: {
        identity: { ...alice, expiresAt: '2020-01-01T00:00:00.000Z' },
      },
    })).rejects.toMatchObject({ code: 'IDENTITY_EXPIRED' });
  });
});
