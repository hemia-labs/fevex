import { expect, test } from 'bun:test';
import { createFevex } from '@fevex/core';
import { fakeModel } from '@fevex/core/testing';
import { createSQLiteRunStore } from '@fevex/sqlite';
import {
  capabilityAgents,
  capabilityTools,
  connections,
  contextProviders,
  memoryStore,
} from './capability-demos';
import { agentCatalog, agents, tools } from './agents.config';

test('capability demos exercise OpenAPI, approval and knowledge contracts', async () => {
  expect(capabilityAgents.map(({ name }) => name)).toEqual([
    'mcp-tools',
    'billing-openapi',
    'refund-approval',
    'knowledge-support',
  ]);

  const provider = connections[0]!.provider;
  await expect(provider.callTool(
    'getInvoice',
    { path: { invoiceId: 'INV-10' } },
    {},
  )).resolves.toEqual({
    invoiceId: 'INV-10',
    amount: 1_250,
    currency: 'MXN',
    status: 'paid',
  });

  expect(connections.find(({ name }) => name === 'nest_mcp')).toMatchObject({
    allowlist: ['echo', 'sum', 'multiply', 'slugify', 'word_count'],
  });
  expect(capabilityAgents.find(({ name }) => name === 'mcp-tools')).toMatchObject({
    tools: [
      'nest_mcp__echo',
      'nest_mcp__sum',
      'nest_mcp__multiply',
      'nest_mcp__slugify',
      'nest_mcp__word_count',
    ],
  });

  expect(capabilityTools[0]).toMatchObject({
    approval: 'required',
    idempotency: 'keyed',
    risk: 'sensitive',
  });

  const knowledgeContext = {
    agentName: 'knowledge-support',
    input: 'Spanish preference',
    sessionId: 'session-1',
    context: { attributes: { plan: 'pro', region: 'MX' } },
  };
  const blocks = (await Promise.all(
    contextProviders.map((provider) => provider.read(knowledgeContext)),
  )).flat();
  expect(blocks.map(({ content }) => content).join(' ')).toContain('30 days');
  expect(blocks.map(({ content }) => content).join(' ')).toContain('pro');

  await memoryStore.write({
    content: 'The customer prefers Spanish.',
    agentName: 'knowledge-support',
    sessionId: 'session-1',
  }, knowledgeContext);
  await expect(memoryStore.search({
    query: 'Spanish',
    agentName: 'knowledge-support',
    sessionId: 'session-1',
  }, knowledgeContext)).resolves.toHaveLength(1);

  const runStore = createSQLiteRunStore({ filename: ':memory:' });
  try {
    expect(() => createFevex({
      models: { default: fakeModel({ output: 'ok' }) },
      agents: capabilityAgents,
      tools: capabilityTools,
      connections,
      contextProviders,
      memoryStore,
      runStore,
    })).not.toThrow();
  } finally {
    await runStore.close();
  }
});

test('nest demo exposes a sandboxed local command agent', () => {
  expect(agentCatalog.find(({ name }) => name === 'sandbox-code')).toMatchObject({
    label: 'Código Sandbox',
  });
  const sandboxAgent = agents.find(({ name }) => name === 'sandbox-code');
  if (!sandboxAgent || !('tools' in sandboxAgent)) throw new Error('Missing sandbox-code agent.');
  expect(sandboxAgent.tools).toEqual(['sandbox_run']);
  const opsAgent = agents.find(({ name }) => name === 'ops');
  if (!opsAgent || !('tools' in opsAgent)) throw new Error('Missing ops agent.');
  expect(opsAgent.tools).toEqual([
    'accounts_get',
    'tickets_recent',
    'metrics_get',
    'incidents_open',
    'escalations_create',
  ]);
  expect(tools.find(({ name }) => name === 'sandbox_run')).toMatchObject({
    sandbox: {
      process: { commands: [process.execPath], timeoutMs: 1_000 },
      filesystem: { cwd: '.' },
      network: false,
      resources: { timeoutMs: 1_000, maxOutputBytes: 2_048 },
    },
  });
});
