import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createFevex } from '@fevex/core';
import { createFevexHttpClient, createFevexHttpHandler } from '@fevex/core/http';
import { createResearchFixtures, researchAgent } from '../../research/agent';
import { scriptedResearchModel } from '../../research/evaluation';
import { readResearchAnswer } from '../../research/answer';
import { agentCatalog, agents } from './agents.config';
import { AgentsController } from './agents.controller';
import type { FevexService } from './fevex.service';

test('playground catalog uses the shared research definition and public HTTP execution', async () => {
  expect(agents.find(({ name }) => name === 'research')).toBe(researchAgent);
  expect(agentCatalog.find(({ name }) => name === 'research')?.examples).toHaveLength(3);
  const app = createFevex({ models: { default: scriptedResearchModel(['combined']) }, agents: [researchAgent],
    connections: createResearchFixtures(resolve(__dirname, '../../../apps/web/src/content/docs/docs')) });
  const handler = createFevexHttpHandler({ fevex: app });
  const client = createFevexHttpClient({ baseUrl: 'http://nest.fixture', fetch: async (input, init) => handler(new Request(input, init)) });
  const run = await client.startRun('research', { input: '¿Cómo uso resumeRun y cuál es el estado y plan de la cuenta 42?' });
  const providers: string[] = [];
  for await (const event of client.observeRun(run.id)) {
    if (event.type === 'tool.completed' && event.payload.source) providers.push(event.payload.source.provider);
  }
  const completed = await client.getRun(run.id);
  expect(completed.status).toBe('completed');
  expect(readResearchAnswer(completed.output)?.sources[0]?.url).toBe('https://fevex.dev/docs/workflows/');
  expect(providers).toEqual(['mcp', 'openapi']);
});

test('evaluation endpoint validates the selected model request before invoking the service', async () => {
  let invoked = false;
  const controller = new AgentsController({ evaluateResearch: async (model: string, signal: AbortSignal) => {
    invoked = true; expect(model).toBe('deepseek'); expect(signal.aborted).toBe(false); return { checked: true };
  } } as unknown as FevexService);
  let report: unknown;
  const response = { destroyed: false, writableEnded: false, on() {}, off() {}, json(value: unknown) { report = value; } };
  await expect(controller.evaluateResearch({ model: 'deepseek', url: 'https://untrusted.example' }, response)).rejects.toThrow('Provide a model ID');
  expect(invoked).toBe(false);
  await controller.evaluateResearch({ model: 'deepseek' }, response);
  expect(report).toEqual({ checked: true });
});
