import { describe, expect, test } from 'bun:test';
import type { AgentIdentity } from '../core';
import { createFevex, defineAgent, defineWorkflow } from '../index';
import { fakeModel } from '../testing';

const parent: AgentIdentity = {
  actor: { id: 'alice' },
  tenant: 'tenant-a',
  scopes: ['read'],
};

function appWith(child: AgentIdentity) {
  return createFevex({
    models: { default: fakeModel({ output: 'done' }, { output: 'done' }) },
    agents: [defineAgent({ name: 'worker', instructions: 'Work.' })],
    workflows: [
      defineWorkflow({
        name: 'flow',
        async run(step, input) {
          const result = await step.agent('child', 'worker', {
            input,
            context: { identity: child },
          });
          return result.output;
        },
      }),
    ],
  });
}

describe('identity delegation', () => {
  test('rejects a child that changes the actor', async () => {
    const app = appWith({ ...parent, actor: { id: 'bob' } });
    await expect(app.runWorkflow('flow', {
      input: 'go',
      context: { identity: parent },
    })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  test('rejects a child that escalates scopes', async () => {
    const app = appWith({ ...parent, scopes: ['read', 'write'] });
    await expect(app.runWorkflow('flow', {
      input: 'go',
      context: { identity: parent },
    })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  test('accepts a child with a subset of scopes', async () => {
    const app = appWith({ ...parent, scopes: [] });
    const result = await app.runWorkflow('flow', {
      input: 'go',
      context: { identity: parent },
    });
    expect(result.output).toBe('done');
  });
});
