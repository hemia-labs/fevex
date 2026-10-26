import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createFevex } from '@fevex/core';
import { createDeepSeek } from '@fevex/deepseek';
import { createOpenAI } from '@fevex/openai';
import { textReporter } from '@fevex/core/evals';
import { startFixtureServer } from '../connections/server';
import { createResearchConnections, researchAgent } from './agent';
import { evaluateResearch, evaluationPassed, researchDataset, scriptedResearchModel } from './evaluation';

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    provider: { type: 'string' }, model: { type: 'string' }, question: { type: 'string' },
    eval: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
  } });
  if (values.provider && !['openai', 'deepseek'].includes(values.provider)) throw new Error('--provider must be openai or deepseek');
  if (values.provider && !values.model?.trim()) throw new Error('Set --model to the model ID available in your provider account');
  if (!values.provider && (values.model || values.question)) throw new Error('Custom questions require --provider and --model; the default demo is scripted');
  const apiKey = values.provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.DEEPSEEK_API_KEY;
  if (values.provider && !apiKey) throw new Error(`Set ${values.provider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY'}`);
  const model = values.provider === 'openai' ? createOpenAI({ apiKey: apiKey!, schemaPolicy: 'best-effort' })(values.model!)
    : values.provider === 'deepseek' ? createDeepSeek({ apiKey: apiKey!, schemaPolicy: 'best-effort' })(values.model!)
    : scriptedResearchModel(values.eval ? undefined : ['combined']);
  const signal = AbortSignal.timeout(120_000);
  if (values.eval) {
    const report = await evaluateResearch(model, fileURLToPath(new URL('../../apps/web/src/content/docs/docs/', import.meta.url)), signal);
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else await textReporter(console.log).report(report);
    if (!evaluationPassed(report)) process.exitCode = 1;
  } else {
    const docsUrl = process.env.RESEARCH_MCP_URL;
    const accountsUrl = process.env.RESEARCH_API_URL;
    if (Boolean(docsUrl) !== Boolean(accountsUrl)) throw new Error('Set both RESEARCH_MCP_URL and RESEARCH_API_URL');
    if (docsUrl && !values.provider) throw new Error('External endpoints require --provider and --model');
    const fixture = docsUrl && accountsUrl ? undefined : startFixtureServer();
    try {
      const app = createFevex({
        models: { default: model }, agents: [researchAgent],
        connections: createResearchConnections({
          docsUrl: docsUrl ?? new URL('/mcp', fixture!.server.url), accountsUrl: accountsUrl ?? fixture!.server.url,
          docsHeaders: process.env.RESEARCH_DOCS_TOKEN ? { authorization: `Bearer ${process.env.RESEARCH_DOCS_TOKEN}` } : undefined,
          accountsHeaders: process.env.RESEARCH_API_TOKEN ? { authorization: `Bearer ${process.env.RESEARCH_API_TOKEN}` } : undefined,
        }),
      });
      const result = await app.runAgent(researchAgent.name, { input: values.question ?? researchDataset.cases[2]!.input, signal });
      console.log(JSON.stringify({ runId: result.runId, answer: result.output }, null, 2));
    } finally { await fixture?.server.stop(true); }
  }
}
