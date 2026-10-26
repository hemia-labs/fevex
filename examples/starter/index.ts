import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createFevex } from '@fevex/core';
import type { RunTrace } from '@fevex/core/observability';
import { createFevexHttpHandler } from '@fevex/core/http';
import { fakeModel } from '@fevex/core/testing';
import { getAccount, support } from './agent';

export async function runDemo() {
  const traces: RunTrace[] = [];
  const model = fakeModel(
    { toolCalls: [{ id: 'account-lookup', name: 'accounts_get', input: { accountId: 42 } }] },
    { output: 'Account 42 is active.' },
  );
  const app = createFevex({
    models: { primary: model },
    agents: [support],
    tools: [getAccount],
    observability: { exporters: [{ export(trace) { traces.push(structuredClone(trace)); } }] },
  });
  const result = await app.runAgent('support', { input: 'What is the status of account 42?' });
  await app.flushObservability();
  const run = await app.getRun(result.runId);
  assert(run?.status === 'completed');
  assert.equal(result.output, 'Account 42 is active.');
  assert.equal(model.calls[1]?.messages.find((message) => message.role === 'tool')?.content,
    '{"accountId":42,"status":"active"}');
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.content, undefined);
  assert.deepEqual(traces[0]?.spans.map((span) => span.kind), ['model', 'tool', 'model']);
  assert.throws(() => getAccount.execute({ accountId: 'invalid' }), /integer/);
  return { app, run, trace: traces[0]!, output: result.output };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { serve: { type: 'boolean', default: false } } });
  const { app, run, trace, output } = await runDemo();
  console.log(JSON.stringify({ runId: run.id, status: run.status, output, trace }, null, 2));
  if (values.serve) {
    const handler = createFevexHttpHandler({ fevex: app });
    // This debug host only exposes reads of the completed in-memory demo run.
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch: (request) => request.method === 'GET'
        ? handler(request) : new Response(null, { status: 405 }),
    });
    console.log(JSON.stringify({ api: server.url.origin, runId: run.id }));
    process.once('SIGINT', () => { void server.stop(true); });
    process.once('SIGTERM', () => { void server.stop(true); });
  }
}
