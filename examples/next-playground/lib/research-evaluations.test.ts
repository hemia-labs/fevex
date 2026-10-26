import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { requestResearchEvaluation } from './research-evaluations';
import { ResearchAnswerView } from '../components/research-answer';
import { readResearchAnswer } from '../../research/answer';

test('evaluation client submits only model selection and preserves recoverable HTTP failures', async () => {
  let calls = 0;
  const report = { schemaVersion: 'fevex.eval.v1', suiteName: 'research', targetVersion: 'test-model', agentName: 'research',
    dataset: { name: 'research-fixtures', version: '1' }, scorerIds: ['research.evidence'],
    cases: ['documentation', 'account', 'combined', 'no-matches', 'missing-id', 'code-unavailable', 'api-unavailable'].map((caseId) => ({
      caseId, status: caseId === 'api-unavailable' ? 'failed' : 'completed', tools: [], latencyMs: 1,
      scores: [{ scorerId: 'research.evidence', status: 'passed', score: 1 }],
    })), summary: { caseCount: 7, passedScoreCount: 7, failedScoreCount: 0, errorScoreCount: 0, latencyMs: 7 },
  };
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls += 1;
    expect(url).toBe('http://localhost:3001/research/evaluations');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'deepseek' });
    return Response.json(report);
  };
  await expect(requestResearchEvaluation('http://localhost:3001/', '', new AbortController().signal, fetchImpl)).rejects.toThrow('Selecciona');
  expect(calls).toBe(0);
  expect((await requestResearchEvaluation('http://localhost:3001/', 'deepseek', new AbortController().signal, fetchImpl)).targetVersion).toBe('test-model');
  for (const [status, message] of [[401, 'Inicia sesión'], [403, 'No tienes permiso'], [409, 'Ya hay una evaluación'], [429, 'límite de solicitudes'], [500, 'Puedes volver']] as const) {
    await expect(requestResearchEvaluation('http://localhost:3001', 'deepseek', new AbortController().signal,
      async () => new Response(null, { status }))).rejects.toThrow(message);
  }
  await expect(requestResearchEvaluation('http://localhost:3001', 'deepseek', new AbortController().signal,
    async () => Response.json({ ...report, cases: [] }))).rejects.toThrow('incompleto');
  await expect(requestResearchEvaluation('http://localhost:3001', 'deepseek', new AbortController().signal,
    async () => Response.json({ ...report, summary: { caseCount: 7 } }))).rejects.toThrow('incompleto');
});

test('research answer renders cited evidence and account facts without executing source content', () => {
  const answer = readResearchAnswer({ answer: '1. Usa `resumeRun`.\n\n```ts\nawait app.resumeRun(runId, {});\n// <script>alert(1)</script>\n```\n\n![remote](https://untrusted.example/image)', status: 'answered', account: { id: 42, status: 'active', plan: 'pro' },
    sources: [{ title: 'Workflows', url: 'https://fevex.dev/docs/workflows/', quote: '<script>alert(1)</script>' }] });
  expect(answer).toBeDefined();
  const html = renderToStaticMarkup(createElement(ResearchAnswerView, { answer: answer! }));
  expect(html).toContain('Fuentes citadas');
  expect(html).toContain('https://fevex.dev/docs/workflows/');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('active');
  expect(html).toContain('<ol>');
  expect(html).toContain('await app.resumeRun');
  expect(html).toContain('Copiar');
  expect(html).toContain('<pre');
  expect(html).not.toContain('<img');
});
