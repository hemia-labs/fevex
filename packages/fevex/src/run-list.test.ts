import { describe, expect, test } from 'bun:test';
import { InMemoryRunStore, type RunStore } from './runtime';
import { fakeModel, testRunCatalog } from './testing';
import { createFevex, defineAgent } from './index';

describe('run catalog', () => {
  test('in-memory store passes the list contract', async () => {
    await testRunCatalog(new InMemoryRunStore());
  });

  test('runtime exposes listing through the public API', async () => {
    const store = new InMemoryRunStore();
    const app = createFevex({
      models: { default: fakeModel({ output: 'one' }, { output: 'two' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
      runStore: store,
    });
    const first = await app.startAgent('assistant', { input: 'one' });
    await app.waitForRun(first.id);
    const second = await app.startAgent('assistant', { input: 'two' });
    await app.waitForRun(second.id);

    const page = await app.listRuns({ limit: 1 });
    expect(page.runs.map(({ id }) => id)).toEqual([second.id]);
    expect(page.next).toBeDefined();

    const next = await app.listRuns({ limit: 1, cursor: page.next });
    expect(next.runs.map(({ id }) => id)).toEqual([first.id]);
    expect(next.next).toBeUndefined();
  });

  test('fails clearly when the configured store cannot list runs', async () => {
    const store: RunStore = {
      async getRun() {
        return undefined;
      },
      async saveRun() {},
      async getSession() {
        return undefined;
      },
      async saveSession() {},
      async appendEvent() {},
      async listEvents() {
        return [];
      },
    };
    const app = createFevex({
      models: { default: fakeModel({ output: 'done' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
      runStore: store,
    });

    await expect(app.listRuns()).rejects.toMatchObject({
      code: 'RUN_LIST_UNSUPPORTED',
    });
  });
});
