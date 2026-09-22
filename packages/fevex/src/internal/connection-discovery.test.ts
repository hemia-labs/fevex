import { expect, test } from 'bun:test';
import { createComposition } from './configuration';

test('discovery recovers after failure and does not reuse another identity catalog', async () => {
  let calls = 0;
  const composition = createComposition({ models: {}, agents: [], connections: [{
    name: 'remote', allowlist: ['lookup'], provider: {
      async listTools(context) {
        if (++calls === 1) throw new Error('temporary outage');
        return context?.runId === 'alice' ? [{ name: 'lookup', description: 'alice only' }] : [];
      },
      callTool: () => null,
    },
  }] });
  const tool = composition.tools.get('remote__lookup')!;
  await expect(tool.resolve!({ runId: 'alice' })).rejects.toThrow();
  await expect(tool.resolve!({ runId: 'alice' })).resolves.toMatchObject({ description: 'alice only' });
  await expect(tool.resolve!({ runId: 'bob' })).resolves.toBeUndefined();
  const [alice, bob] = await Promise.all([tool.resolve!({ runId: 'alice' }), tool.resolve!({ runId: 'bob' })]);
  expect(alice?.description).toBe('alice only');
  expect(bob).toBeUndefined();
  expect(calls).toBe(5);
});
