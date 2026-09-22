import { expect } from 'bun:test';
import { createFevex, defineAgent } from '../packages/fevex/src/index';
import type { DurableRunStore, RunLease } from '../packages/fevex/src/runtime';

export async function testLeaseProcesses(
  backend: 'sqlite' | 'postgres', location: string, store: DurableRunStore,
): Promise<void> {
  const app = createFevex({
    runStore: store, agents: [defineAgent({ name: 'worker', instructions: 'Work.' })],
    models: { default: { async *stream() {
      yield { type: 'output.delta' as const, delta: 'done' };
      yield { type: 'completed' as const, result: { output: 'done' } };
    } } },
  });
  const result = await app.runAgent('worker', { input: 'seed' });
  const original = (await store.getRun(result.runId))!;
  const oldLease: RunLease = {
    generation: 0, runId: result.runId, ownerId: 'reused-owner',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  expect(await store.acquireLease(oldLease)).toBe(true);
  let ready!: () => void;
  let done!: (value: { committed: boolean; renewed: boolean }) => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const finished = new Promise<{ committed: boolean; renewed: boolean }>((resolve) => { done = resolve; });
  const child = Bun.spawn([
    process.execPath, new URL('./lease-worker.ts', import.meta.url).pathname,
    backend, location, JSON.stringify(oldLease),
  ], {
    stdout: 'ignore', stderr: 'pipe',
    ipc(message) {
      if (message.type === 'ready') ready();
      if (message.type === 'result') done({ committed: message.committed, renewed: message.renewed });
    },
  });
  const exited = child.exited.then(async (code) => {
    throw new Error(`Lease worker exited (${code}): ${await new Response(child.stderr).text()}`);
  });
  try {
    await Promise.race([started, exited]);
    await store.releaseLease(oldLease.runId, oldLease.ownerId, oldLease.generation);
    const candidates = [{ ...oldLease, generation: 0 }, { ...oldLease, generation: 0 }];
    const acquired = await Promise.all(candidates.map((lease) => store.acquireLease(lease)));
    expect(acquired.filter(Boolean)).toHaveLength(1);
    const current = candidates[acquired.indexOf(true)]!;
    expect(current.generation).toBeGreaterThan(oldLease.generation);
    // The run revision is unchanged: only fencing can distinguish these workers.
    expect((await store.getRun(original.id))?.revision).toBe(original.revision);
    child.send({ type: 'commit' });
    expect(await Promise.race([finished, exited])).toEqual({ committed: false, renewed: false });
    expect(await child.exited).toBe(0);
    expect(await store.getRun(original.id)).toEqual(original);
    expect(await store.renewLease(current)).toBe(true);
    expect(await store.commitExecution({
      lease: current, expectedRevision: original.revision, run: original,
    })).toBe(true);
    await store.releaseLease(current.runId, current.ownerId, current.generation);
  } finally {
    child.kill();
    await child.exited;
  }
}
