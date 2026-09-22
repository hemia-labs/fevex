import { expect } from 'bun:test';
import { createFevex, defineAgent } from '../packages/fevex/src/index';
import type { DurableRunStore } from '../packages/fevex/src/runtime';

type Message = { type: string; runId?: string; code?: string; message?: string };

function worker(backend: string, location: string, sessionId: string, input: string, leaseMs = 30_000) {
  let receive!: (message: Message) => void;
  const first = new Promise<Message>((resolve) => { receive = resolve; });
  const child = Bun.spawn([
    process.execPath, new URL('./session-worker.ts', import.meta.url).pathname,
    backend, location, sessionId, input, String(leaseMs),
  ], {
    stdout: 'ignore', stderr: 'pipe',
    ipc(message) { receive(message as Message); },
  });
  // A startup failure must fail immediately instead of hanging on an IPC message.
  const exited = child.exited.then(async (code) => {
    throw new Error(`Worker exited (${code}): ${await new Response(child.stderr).text()}`);
  });
  return { child, first: Promise.race([first, exited]) };
}

export async function testSessionProcesses(
  backend: 'sqlite' | 'postgres', location: string, store: DurableRunStore,
): Promise<void> {
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  await store.saveSession({ id: sessionId, history: [], createdAt: now, updatedAt: now });
  const left = worker(backend, location, sessionId, 'left');
  const right = worker(backend, location, sessionId, 'right');
  const app = createFevex({
    runStore: store,
    agents: [defineAgent({ name: 'worker', instructions: 'Work.' })],
    models: { default: { async *stream() {
      yield { type: 'output.delta' as const, delta: 'done' };
      yield { type: 'completed' as const, result: { output: 'done' } };
    } } },
  });
  try {
    const messages = await Promise.all([left.first, right.first]);
    expect(messages.map(({ type }) => type).sort()).toEqual(['entered', 'error']);
    const winner = messages[0]!.type === 'entered' ? left : right;
    const loser = winner === left ? right : left;
    expect(messages.find(({ type }) => type === 'error')?.code).toBe('RUN_CONFLICT');
    await loser.child.exited;
    await expect(app.compactSession(sessionId, 'summary')).rejects.toMatchObject({ code: 'RUN_CONFLICT' });
    winner.child.send({ type: 'release' });
    expect(await winner.child.exited).toBe(0);
    await app.runAgent('worker', { sessionId, input: 'next' });
    const history = (await store.getSession(sessionId))!.history;
    expect(history.map(({ content }) => content)).toEqual([
      winner === left ? 'left' : 'right', 'done', 'next', 'done',
    ]);
    await app.compactSession(sessionId, 'summary');
    expect((await store.getSession(sessionId))!.history).toEqual([{ role: 'system', content: 'summary' }]);
  } finally {
    left.child.kill();
    right.child.kill();
    await Promise.all([left.child.exited, right.child.exited]);
  }

  const crashed = worker(backend, location, sessionId, 'recover me', 1000);
  try {
    const started = await crashed.first;
    expect(started.type).toBe('entered');
    crashed.child.kill('SIGKILL');
    await crashed.child.exited;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // Expiring a worker lease must not hand its conversation to a different run.
    await expect(app.runAgent('worker', { sessionId, input: 'intruder' }))
      .rejects.toMatchObject({ code: 'RUN_CONFLICT' });
    await app.recoverRun(started.runId!, { actor: { id: 'recovery-worker' } });
    const deadline = Date.now() + 3000;
    while ((await store.getRun(started.runId!))?.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await store.getRun(started.runId!))?.status).toBe('completed');
    await app.runAgent('worker', { sessionId, input: 'after recovery' });
    expect((await store.getSession(sessionId))!.history.map(({ content }) => content))
      .toEqual(['summary', 'recover me', 'done', 'after recovery', 'done']);
  } finally {
    crashed.child.kill();
    await crashed.child.exited;
  }
}
