import { describe, expect, test } from 'bun:test';
import { defineAgent } from '../agents';
import type { ExecutionContext } from '../core';
import { createFevex, type Fevex } from '../fevex';
import type { AgentRun } from '../runtime';
import { fakeModel } from '../testing';
import {
  createFevexHttpHandler,
  type FevexHttpAccess,
  type FevexHttpHandler,
} from './index';

const alice: ExecutionContext = {
  actor: { id: 'alice' },
  attributes: { tenantId: 'tenant-a' },
};
const bob: ExecutionContext = {
  actor: { id: 'bob' },
  attributes: { tenantId: 'tenant-b' },
};

const pausedRun = {
  id: 'run-1',
  sessionId: 'session-1',
  agentName: 'assistant',
  status: 'paused',
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies AgentRun;

describe('HTTP resource authorization', () => {
  test('gates every operation before touching the store', async () => {
    const calls: string[] = [];
    const access: FevexHttpAccess[] = [];
    const started: Array<{ id: string; actor?: string }> = [];
    const startContexts: unknown[] = [];
    const app = {
      async startAgent(_name: string, request: { context?: unknown }) {
        calls.push('startAgent');
        startContexts.push(request.context);
        return { ...pausedRun, status: 'running' as const };
      },
      async startWorkflow(_name: string, request: { context?: unknown }) {
        calls.push('startWorkflow');
        startContexts.push(request.context);
        return { ...pausedRun, kind: 'workflow' as const, workflowName: 'flow' };
      },
      async startTeam(_name: string, request: { context?: unknown }) {
        calls.push('startTeam');
        startContexts.push(request.context);
        return { ...pausedRun, kind: 'team' as const, teamName: 'team' };
      },
      async getRun() {
        calls.push('getRun');
        return pausedRun;
      },
      async listEvents() {
        calls.push('listEvents');
        return [];
      },
      async cancelRun() {
        calls.push('cancelRun');
        return true;
      },
      async resumeRun() {
        calls.push('resumeRun');
        return pausedRun;
      },
      async recoverRun() {
        calls.push('recoverRun');
        return pausedRun;
      },
    } as unknown as Fevex;
    const handler = createFevexHttpHandler({
      fevex: app,
      async authorize(value) {
        access.push(value);
        return value.context?.actor?.id === 'alice';
      },
      onRunStarted(run, context) {
        started.push({ id: run.id, actor: context?.actor?.id });
      },
    });

    const denied = [
      await invoke(handler, '/v1/agents/assistant/runs', bob, json('POST', {
        input: 'hello',
        sessionId: pausedRun.sessionId,
      })),
      await invoke(handler, '/v1/workflows/flow/runs', bob, json('POST', { input: 'hello' })),
      await invoke(handler, '/v1/teams/team/runs', bob, json('POST', { input: 'hello' })),
      await invoke(handler, '/v1/runs/run-1', bob),
      await invoke(handler, '/v1/runs/run-1/events', bob),
      await invoke(handler, '/v1/runs/run-1', bob, { method: 'DELETE' }),
      await invoke(handler, '/v1/runs/run-1/resume', bob, json('POST', { type: 'timer' })),
      await invoke(handler, '/v1/runs/run-1/recover', bob, { method: 'POST' }),
    ];

    for (const response of denied) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
    expect(calls).toEqual([]);
    expect(started).toEqual([]);
    expect(access.map(({ action }) => action)).toEqual([
      'start',
      'start',
      'start',
      'read',
      'observe',
      'cancel',
      'resume',
      'recover',
    ]);
    expect(access[0]).toEqual({
      action: 'start',
      kind: 'agent',
      name: 'assistant',
      sessionId: pausedRun.sessionId,
      context: bob,
    });

    expect((await invoke(handler, '/v1/agents/assistant/runs', alice, json('POST', {
      input: 'hello',
      sessionId: pausedRun.sessionId,
    }))).status).toBe(202);
    expect((await invoke(handler, '/v1/workflows/flow/runs', alice, json('POST', {
      input: 'hello',
    }))).status).toBe(202);
    expect((await invoke(handler, '/v1/teams/team/runs', alice, json('POST', {
      input: 'hello',
    }))).status).toBe(202);
    expect((await invoke(handler, '/v1/runs/run-1', alice)).status).toBe(200);
    const events = await invoke(handler, '/v1/runs/run-1/events', alice);
    expect(events.status).toBe(200);
    await events.body?.cancel();
    expect((await invoke(handler, '/v1/runs/run-1', alice, { method: 'DELETE' })).status).toBe(204);
    expect((await invoke(handler, '/v1/runs/run-1/resume', alice, json('POST', {
      type: 'timer',
    }))).status).toBe(202);
    expect((await invoke(handler, '/v1/runs/run-1/recover', alice, {
      method: 'POST',
    })).status).toBe(202);

    expect(calls.slice(0, 3)).toEqual(['startAgent', 'startWorkflow', 'startTeam']);
    expect(calls).toEqual(expect.arrayContaining([
      'startAgent',
      'startWorkflow',
      'startTeam',
      'getRun',
      'listEvents',
      'cancelRun',
      'resumeRun',
      'recoverRun',
    ]));
    expect(started).toEqual([
      { id: 'run-1', actor: 'alice' },
      { id: 'run-1', actor: 'alice' },
      { id: 'run-1', actor: 'alice' },
    ]);
    expect(startContexts).toEqual([alice, alice, alice]);
  });

  test('isolates two identities with a host ownership map', async () => {
    const app = createFevex({
      models: { default: fakeModel({ output: 'ok' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
    });
    const runOwners = new Map<string, string>();
    const sessionOwners = new Map<string, string>();
    const handler = createFevexHttpHandler({
      fevex: app,
      authorize(access) {
        const actor = access.context?.actor?.id;
        if (!actor) return false;
        if (access.action === 'start') {
          return !access.sessionId || sessionOwners.get(access.sessionId) === actor;
        }
        return runOwners.get(access.runId) === actor;
      },
      onRunStarted(run, context) {
        const actor = context?.actor?.id;
        if (!actor) return;
        runOwners.set(run.id, actor);
        sessionOwners.set(run.sessionId, actor);
      },
    });

    const start = await invoke(handler, '/v1/agents/assistant/runs', alice, json('POST', {
      input: 'hello',
    }));
    expect(start.status).toBe(202);
    const run = await start.json() as AgentRun;
    expect(runOwners.get(run.id)).toBe('alice');
    expect(sessionOwners.get(run.sessionId)).toBe('alice');

    expect((await invoke(handler, `/v1/runs/${run.id}`, bob)).status).toBe(403);
    expect((await invoke(handler, `/v1/runs/${run.id}/events`, bob)).status).toBe(403);
    expect((await invoke(handler, `/v1/runs/${run.id}`, bob, { method: 'DELETE' })).status).toBe(403);
    expect((await invoke(handler, '/v1/agents/assistant/runs', bob, json('POST', {
      input: 'join',
      sessionId: run.sessionId,
    }))).status).toBe(403);

    const observed = await invoke(handler, `/v1/runs/${run.id}/events`, alice);
    expect(observed.status).toBe(200);
    expect(await observed.text()).toContain('run.completed');

    const continued = await invoke(handler, '/v1/agents/assistant/runs', alice, json('POST', {
      input: 'again',
      sessionId: run.sessionId,
    }));
    expect(continued.status).toBe(202);
    expect(await app.getRun(run.id)).toBeDefined();
  });

  test('fails closed when authorization or ownership persistence fails', async () => {
    const calls: string[] = [];
    const authorizationFailure = createFevexHttpHandler({
      fevex: {
        async getRun() {
          calls.push('getRun');
          return pausedRun;
        },
      } as unknown as Fevex,
      authorize() {
        throw new Error('authorization store unavailable');
      },
    });
    const unauthorized = await invoke(authorizationFailure, '/v1/runs/run-1', alice);
    expect(unauthorized.status).toBe(500);
    expect(calls).toEqual([]);

    const observed: string[] = [];
    const ownershipFailure = createFevexHttpHandler({
      fevex: {
        async startAgent() {
          return { ...pausedRun, status: 'running' as const };
        },
        async cancelRun(runId: string) {
          observed.push(runId);
          return true;
        },
      } as unknown as Fevex,
      async onRunStarted() {
        throw new Error('owner store unavailable');
      },
      onError(_error, problem) {
        observed.push(problem.code);
      },
    });
    const failed = await invoke(ownershipFailure, '/v1/agents/assistant/runs', alice, json('POST', {
      input: 'hello',
    }));
    expect(failed.status).toBe(500);
    expect(observed).toEqual([pausedRun.id, 'INTERNAL_ERROR']);
  });

  test('does not reveal a missing run before authentication', async () => {
    const handler = createFevexHttpHandler({
      fevex: {
        async getRun() {
          return undefined;
        },
      } as unknown as Fevex,
    });
    const response = await handler(
      new Request('http://local/v1/runs/missing/recover', { method: 'POST' }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'ACTOR_REQUIRED' });
  });
});

function invoke(
  handler: FevexHttpHandler,
  path: string,
  context: ExecutionContext,
  init: RequestInit = {},
) {
  return handler(new Request(`http://local${path}`, init), { context });
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
