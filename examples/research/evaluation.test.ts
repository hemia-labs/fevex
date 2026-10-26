import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { AgentMessage } from '@fevex/core';
import type { EvalScorerContext } from '@fevex/core/evals';
import { evaluateResearch, evaluationPassed, groundingScorer, codeScorer, researchDataset, scriptedResearchModel } from './evaluation';
import { documentSections, codeBlocks, createFixtureService } from '../connections/fixtures';
import { readResearchAnswer } from './answer';

test('research evaluates actual MCP/OpenAPI replies, missing data and expected API failure', async () => {
  const report = await evaluateResearch(scriptedResearchModel(), fileURLToPath(new URL('../../apps/web/src/content/docs/docs/', import.meta.url)));
  expect(evaluationPassed(report)).toBe(true);
  expect(report.summary).toMatchObject({ caseCount: 7, completedCount: 6, failedCount: 1, passedScoreCount: 21, failedScoreCount: 0, errorScoreCount: 0 });
  expect(report.cases[2]?.tools).toEqual(['docs__search', 'accounts__getAccount']);
  expect(readResearchAnswer(report.cases[2]?.output)?.account).toEqual({ id: 42, status: 'active', plan: 'pro' });
  expect(report.cases.find(({ caseId }) => caseId === 'api-unavailable')).toMatchObject({ status: 'failed', scores: [{ status: 'passed' }, { status: 'passed', details: { expectedFailure: true } }, { status: 'passed' }] });
  expect(report.cases.find(({ caseId }) => caseId === 'code-unavailable')?.output).toMatchObject({ status: 'insufficient' });
  expect(codeBlocks(readResearchAnswer(report.cases[2]?.output)!.answer)[0]).toContain("eventName: 'review.approved'");
});

test('documentation search preserves section context and complete fenced examples', async () => {
  const markdown = '---\ntitle: Test\n---\n## First\nContext.\n```ts\n// ## Inside code\nconst x = 1;\n```\nAfter code.\n## Second\nOther content.';
  expect(documentSections(markdown)).toHaveLength(2);
  expect(documentSections(markdown)[0]).toContain('After code.');
  expect(codeBlocks(documentSections(markdown)[0]!)).toEqual(['// ## Inside code\nconst x = 1;']);
  expect(codeBlocks('~~~~ts\nconst x = 1;\n~~~~')).toEqual(['const x = 1;']);
  expect(documentSections('## Broken\n```ts\nconst unfinished =')).toEqual([]);
  expect(() => codeBlocks('```ts\nconst unfinished =')).toThrow('Unclosed');
  const fixture = createFixtureService(fileURLToPath(new URL('../../apps/web/src/content/docs/docs/', import.meta.url)));
  const response = await fixture.fetch(new Request('http://research.fixture/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'resumeRun' } } }) }));
  const { result } = await response.json() as { result: { structuredContent: { matches: { excerpt: string }[] } } };
  const excerpt = result.structuredContent.matches[0]!.excerpt;
  expect(excerpt).toContain('authenticated');
  expect(excerpt).toContain('Observe the run');
  expect(codeBlocks(excerpt)[0]).toContain('await app.resumeRun(runId, {');
  expect(codeBlocks(excerpt)[0]).toEndWith('});');
  expect(codeBlocks(excerpt)[0]).not.toContain('recoverRun');
});

test('code scorer rejects invented, modified, partial and uncited code', async () => {
  const testCase = researchDataset.cases[2]!;
  const original = "await app.resumeRun(runId, {\n  type: 'event',\n  eventName: 'review.approved',\n});";
  const source = { title: 'Workflows & teams', url: 'https://fevex.dev/docs/workflows/', quote: 'Paused runs resume with `resumeRun`' };
  const evidence: AgentMessage[] = [{ role: 'tool', name: 'docs__search', content: JSON.stringify({ matches: [{ ...source, excerpt: `${source.quote}\n\n\`\`\`ts\n${original}\n\`\`\`` }] }) }];
  const scorer = codeScorer(new Map([[testCase.input, evidence]]));
  const valid = { answer: `Use resumeRun.\n\n\`\`\`ts\n${original}\n\`\`\``, status: 'answered', sources: [source], account: null };
  const context: EvalScorerContext<string> = { testCase, output: valid, events: [], tools: testCase.expected!.tools!, latencyMs: 1 };
  expect(await scorer.score(context)).toMatchObject({ passed: true });
  for (const output of [
    { ...valid, answer: valid.answer.replace('review.approved', 'invented.event') },
    { ...valid, answer: '```ts\nawait app.resumeRun(runId);\n```' },
    { ...valid, answer: '```ts\nawait app.resumeRun(runId);' },
    { ...valid, answer: 'Use resumeRun without an example.' },
    { ...valid, sources: [{ ...source, url: 'https://invented.example' }] },
  ]) expect(await scorer.score({ ...context, output })).toMatchObject({ passed: false });
});

test('evidence scorer rejects invented URLs, quotes and account facts', async () => {
  const testCase = researchDataset.cases[2]!;
  const source = { title: 'Workflows & teams', url: 'https://fevex.dev/docs/workflows/', quote: 'Paused runs resume with `resumeRun`' };
  const account = { id: 42, status: 'active', plan: 'pro' };
  const evidence: AgentMessage[] = [
    { role: 'tool', name: 'docs__search', content: JSON.stringify({ matches: [{ ...source, excerpt: source.quote }] }) },
    { role: 'tool', name: 'accounts__getAccount', content: JSON.stringify(account) },
  ];
  const scorer = groundingScorer(new Map([[testCase.input, evidence]]));
  const valid = { answer: 'Use resumeRun.', status: 'answered', sources: [source], account };
  const context: EvalScorerContext<string> = { testCase, output: valid, events: [], tools: testCase.expected!.tools!, latencyMs: 1 };
  expect(await scorer.score(context)).toMatchObject({ passed: true });
  const wrappedEvidence = evidence.map((message) => message.name === 'docs__search'
    ? { ...message, content: JSON.stringify({ matches: [{ ...source, excerpt: 'Paused runs\nresume with `resumeRun`' }] }) }
    : message);
  expect(await groundingScorer(new Map([[testCase.input, wrappedEvidence]])).score(context)).toMatchObject({ passed: true });
  for (const output of [
    { ...valid, sources: [{ ...source, url: 'https://invented.example/doc' }] },
    { ...valid, sources: [{ ...source, quote: 'An invented statement about replays' }] },
    { ...valid, sources: [{ ...source, quote: 'Paused runs never resume with `resumeRun`' }] },
    { ...valid, sources: [{ ...source, quote: 'Paused runsresume with `resumeRun`' }] },
    { ...valid, account: { ...account, status: 'paused' } },
    { ...valid, account: null },
  ]) expect(await scorer.score({ ...context, output })).toMatchObject({ passed: false });
  expect(readResearchAnswer({ ...valid, sources: [{ ...source, url: 'javascript:alert(1)' }] })).toBeUndefined();
  expect(readResearchAnswer({ ...valid, sources: [{ ...source, url: 'https://user:password@example.com' }] })).toBeUndefined();
});
