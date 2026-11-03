import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext } from '@fevex/core';
import type { FevexHttpHandler } from '@fevex/core/http';
import { DemoAuthorization, resolveDemoContext } from './authorization';
import { createDemoHttpHandler } from './fevex.service';

const alice = { actor: { id: 'alice' }, attributes: { tenantId: 'tenant-a' } };
const bob = { actor: { id: 'bob' }, attributes: { tenantId: 'tenant-b' } };

test('resolves demo bearer tokens and isolates runs and sessions', () => {
  expect(resolveDemoContext('Bearer alice-token')).toMatchObject({
    actor: { id: 'alice' },
    attributes: { tenantId: 'tenant-a' },
  });
  expect(resolveDemoContext('Bearer bob-token')).toMatchObject({
    actor: { id: 'bob' },
    attributes: { tenantId: 'tenant-b' },
  });
  expect(resolveDemoContext(undefined)).toBeUndefined();
  expect(resolveDemoContext(undefined, true)).toMatchObject({ actor: { id: 'demo-user' } });
  expect(resolveDemoContext('Bearer unknown')).toBeUndefined();
  expect(resolveDemoContext('Basic alice-token')).toBeUndefined();

  const authorization = new DemoAuthorization();
  const run = { id: 'run-1', sessionId: 'session-1' };
  authorization.claim(run, alice);

  expect(authorization.authorize({ action: 'read', runId: run.id, context: alice })).toBe(true);
  expect(authorization.authorize({ action: 'read', runId: run.id, context: bob })).toBe(false);
  expect(authorization.authorize({ action: 'read', runId: 'missing', context: alice })).toBe(false);
  expect(authorization.authorize({
    action: 'start',
    kind: 'agent',
    name: 'assistant',
    sessionId: run.sessionId,
    context: alice,
  })).toBe(true);
  expect(authorization.authorize({
    action: 'start',
    kind: 'agent',
    name: 'assistant',
    sessionId: run.sessionId,
    context: bob,
  })).toBe(false);
  expect(authorization.authorize({
    action: 'start',
    kind: 'agent',
    name: 'assistant',
    sessionId: 'unknown',
    context: alice,
  })).toBe(false);
  expect(authorization.authorize({
    action: 'start',
    kind: 'agent',
    name: 'assistant',
    context: alice,
  })).toBe(true);
  expect(authorization.authorize({
    action: 'read',
    runId: run.id,
    context: { actor: { id: 'alice' }, attributes: { tenantId: 'tenant-b' } },
  })).toBe(false);
});

test('does not let a later claim take over a session or an unowned run', () => {
  const authorization = new DemoAuthorization();
  authorization.claim({ id: 'run-1', sessionId: 'session-1' }, alice);
  expect(() => {
    authorization.claim({ id: 'run-2', sessionId: 'session-1' }, bob);
  }).toThrow('another actor');

  expect(authorization.authorize({ action: 'read', runId: 'run-1', context: alice })).toBe(true);
  expect(authorization.authorize({ action: 'read', runId: 'run-2', context: bob })).toBe(false);
  expect(authorization.authorize({ action: 'read', runId: 'run-2', context: alice })).toBe(false);

  authorization.claim({ id: 'run-3', sessionId: 'session-3' }, { actor: { id: 'alice' } });
  expect(authorization.authorize({ action: 'read', runId: 'run-3', context: alice })).toBe(false);
});

test('keeps ownership across restarts when a filename is configured', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fevex-auth-'));
  const filename = join(directory, 'owners.json');
  try {
    const first = new DemoAuthorization(filename);
    first.claim({ id: 'run-1', sessionId: 'session-1' }, alice);

    const restarted = new DemoAuthorization(filename);
    expect(restarted.authorize({ action: 'read', runId: 'run-1', context: alice })).toBe(true);
    expect(restarted.authorize({ action: 'read', runId: 'run-1', context: bob })).toBe(false);
    expect(restarted.authorize({
      action: 'start',
      kind: 'agent',
      name: 'assistant',
      sessionId: 'session-1',
      context: alice,
    })).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not collide tenants or actors that contain separators', () => {
  const authorization = new DemoAuthorization();
  const first = { actor: { id: 'a:b' }, attributes: { tenantId: 'tenant:1' } };
  const second = { actor: { id: 'a:b' }, attributes: { tenantId: 'tenant:2' } };
  authorization.claim({ id: 'run-1', sessionId: 'session-1' }, first);

  expect(authorization.authorize({ action: 'read', runId: 'run-1', context: first })).toBe(true);
  expect(authorization.authorize({ action: 'read', runId: 'run-1', context: second })).toBe(false);
});

test('fails startup when the ownership file is corrupt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fevex-auth-corrupt-'));
  const filename = join(directory, 'owners.json');
  writeFileSync(filename, '{');
  try {
    expect(() => new DemoAuthorization(filename)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('requires a token unless demo auth is enabled', async () => {
  const seen: ExecutionContext[] = [];
  const handler: FevexHttpHandler = async (_request, context) => {
    seen.push(context!.context!);
    return new Response('ok');
  };

  const secured = createDemoHttpHandler(handler, () => false);
  expect((await secured(new Request('http://local/v1/agents/assistant/runs'))).status).toBe(401);
  expect((await secured(new Request('http://local/v1/agents/assistant/runs', {
    headers: { authorization: 'Bearer unknown' },
  }))).status).toBe(401);
  expect(seen).toEqual([]);

  const alice = await secured(new Request('http://local/v1/agents/assistant/runs', {
    headers: { authorization: 'Bearer alice-token' },
  }));
  expect(alice.status).toBe(200);
  expect(seen[0]).toMatchObject({ actor: { id: 'alice' } });

  const demo = createDemoHttpHandler(handler, () => true);
  expect((await demo(new Request('http://local/v1/agents/assistant/runs'))).status).toBe(200);
  expect(seen[1]).toMatchObject({ actor: { id: 'demo-user' } });
});
