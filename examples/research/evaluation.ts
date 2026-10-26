import { createFevex, type AgentMessage, type ModelGateway, type ModelResult, type ToolCall } from '@fevex/core';
import { runEvaluation, serializeCanonical, toolSelectionScorer, type EvalDataset, type EvalReport, type EvalScorer, type EvalScorerResult } from '@fevex/core/evals';
import { fakeModel } from '@fevex/core/testing';
import { readFileSync } from 'node:fs';
import { codeBlocks } from '../connections/fixtures';
import { createResearchFixtures, researchAgent } from './agent';
import { readResearchAnswer, type ResearchAnswer } from './answer';

export const researchDataset: EvalDataset<string> = {
  name: 'research-fixtures', version: '3', cases: [
    { id: 'documentation', input: 'Busca resumeRun en la documentación y explica cómo reanudar una ejecución.', expected: { tools: ['docs__search'] } },
    { id: 'account', input: '¿Cuál es el estado y plan de la cuenta 42?', expected: { tools: ['accounts__getAccount'] } },
    { id: 'combined', input: '¿Cómo uso resumeRun y cuál es el estado y plan de la cuenta 42?', expected: { tools: ['docs__search', 'accounts__getAccount'] } },
    { id: 'no-matches', input: 'Busca exactamente zzz_no_documentation_match_9 y explica qué indica la documentación.', expected: { tools: ['docs__search'] } },
    { id: 'missing-id', input: '¿Cuál es el estado y plan de mi cuenta?', expected: { tools: [] } },
    { id: 'code-unavailable', input: 'Busca stepId en la documentación y muestra un ejemplo de código que lo use. Si no existe ese código, indica que la información es insuficiente.', expected: { tools: ['docs__search'] } },
    { id: 'api-unavailable', input: 'Consulta el estado y plan de la cuenta 503.', expected: { tools: ['accounts__getAccount'] } },
  ],
};

const account: ResearchAnswer['account'] = { id: 42, status: 'active', plan: 'pro' };
const source = {
  title: 'Workflows & teams', url: 'https://fevex.dev/docs/workflows/',
  quote: 'Paused runs resume with `resumeRun`',
};

/** Scripted calls verify plumbing and scorers; they do not measure LLM quality. */
export function scriptedResearchModel(caseIds = researchDataset.cases.map(({ id }) => id)): ModelGateway {
  const resumeCode = codeBlocks(readFileSync(new URL('../../apps/web/src/content/docs/docs/workflows.md', import.meta.url), 'utf8'))
    .find((code) => code.includes('app.resumeRun('));
  if (!resumeCode) throw new Error('The research demo needs the documented resumeRun example');
  const responses = caseIds.flatMap((id): ModelResult[] => {
    const calls: ToolCall[] = [
      ...(['documentation', 'combined', 'no-matches', 'code-unavailable'].includes(id)
        ? [{ id: `${id}-docs`, name: 'docs__search', input: { query: id === 'no-matches' ? 'zzz_no_documentation_match_9' : id === 'code-unavailable' ? 'stepId' : 'resumeRun' } }] : []),
      ...(['account', 'combined', 'api-unavailable'].includes(id)
        ? [{ id: `${id}-account`, name: 'accounts__getAccount', input: { path: { id: id === 'api-unavailable' ? 503 : 42 } } }] : []),
    ];
    if (id === 'api-unavailable') return [{ toolCalls: calls }];
    const hasAccount = ['account', 'combined'].includes(id);
    const hasDocs = ['documentation', 'combined', 'code-unavailable'].includes(id);
    const output: ResearchAnswer = {
      answer: id === 'missing-id' ? 'Necesito un ID de cuenta para consultar sus datos.'
        : id === 'no-matches' ? 'No encontré documentación para esa búsqueda.'
        : id === 'code-unavailable' ? 'La documentación explica stepId, pero no incluye código que lo use.'
        : [hasDocs ? `1. Usa el ID del workflow pausado.\n2. Envía el evento declarado con su payload y actor.\n\n\`\`\`ts\n${resumeCode}\n\`\`\`` : '', hasAccount ? 'La cuenta 42 está activa en el plan pro.' : ''].filter(Boolean).join('\n\n'),
      status: ['no-matches', 'missing-id', 'code-unavailable'].includes(id) ? 'insufficient' : 'answered',
      sources: hasDocs ? [{ ...source, ...(id === 'code-unavailable' ? { quote: '`stepId` is the durable identity of a step' } : {}) }] : [], account: hasAccount ? account : null,
    };
    return [...(calls.length ? [{ toolCalls: calls }] : []), { output }];
  });
  return fakeModel(...responses.map((response) => ({ ...response, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } })));
}

export function groundingScorer(evidence: ReadonlyMap<string, readonly AgentMessage[]>): EvalScorer<string> {
  return {
    id: 'research.evidence',
    score({ testCase, output, events, error }): EvalScorerResult {
      if (testCase.id === 'api-unavailable') {
        const passed = Boolean(error) && output === undefined && events.some((event) => event.type === 'tool.failed'
          && event.payload.toolName === 'accounts__getAccount' && event.payload.errorCode === 'OPENAPI_HTTP_ERROR');
        return { passed, score: passed ? 1 : 0, details: { expectedFailure: true } };
      }
      const answer = readResearchAnswer(output);
      if (!answer || error) return { passed: false, score: 0, details: 'Missing or invalid structured answer' };
      const messages = evidence.get(testCase.input) ?? [];
      const docResults = messages.filter((message) => message.role === 'tool' && message.name === 'docs__search')
        .flatMap((message) => (JSON.parse(message.content) as { matches: { title: string; url: string; excerpt: string }[] }).matches);
      const accountMessage = [...messages].reverse().find((message) => message.role === 'tool' && message.name === 'accounts__getAccount');
      const actualAccount = accountMessage ? JSON.parse(accountMessage.content) : null;
      const hasDocs = ['documentation', 'combined', 'code-unavailable'].includes(testCase.id);
      const insufficient = ['no-matches', 'missing-id', 'code-unavailable'].includes(testCase.id);
      const passed = answer.status === (insufficient ? 'insufficient' : 'answered')
        && (hasDocs ? answer.sources.length > 0 && answer.answer.includes(testCase.id === 'code-unavailable' ? 'stepId' : 'resumeRun') : answer.sources.length === 0)
        && answer.sources.every((citation) => docResults.some((match) => match.url === citation.url && match.title === citation.title
          && citation.quote.trim().length >= 12 && normalizeWhitespace(match.excerpt).includes(normalizeWhitespace(citation.quote))))
        && serializeCanonical(answer.account) === serializeCanonical(actualAccount)
        && (!['account', 'combined'].includes(testCase.id) || answer.account?.id === 42)
        && (testCase.id !== 'no-matches' || docResults.length === 0);
      return { passed, score: passed ? 1 : 0, details: { citations: answer.sources.length, accountMatchesEvidence: serializeCanonical(answer.account) === serializeCanonical(actualAccount) } };
    },
  };
}

export function codeScorer(evidence: ReadonlyMap<string, readonly AgentMessage[]>): EvalScorer<string> {
  return {
    id: 'research.code',
    score({ testCase, output, error }): EvalScorerResult {
      if (testCase.id === 'api-unavailable') return { passed: Boolean(error) && output === undefined, score: error && output === undefined ? 1 : 0 };
      const answer = readResearchAnswer(output);
      if (!answer || error) return { passed: false, score: 0 };
      try {
        const supplied = (evidence.get(testCase.input) ?? []).filter((message) => message.role === 'tool' && message.name === 'docs__search')
          .flatMap((message) => (JSON.parse(message.content) as { matches: { title: string; url: string; excerpt: string }[] }).matches);
        const code = codeBlocks(answer.answer);
        const required = ['documentation', 'combined'].includes(testCase.id);
        const passed = (required ? code.some((block) => block.includes('app.resumeRun(')) : code.length === 0)
          && code.every((block) => block.trim().length > 0 && supplied.some((match) => answer.sources.some((citation) => citation.url === match.url && citation.title === match.title)
            && codeBlocks(match.excerpt).some((original) => original === block)));
        return { passed, score: passed ? 1 : 0, details: { codeBlocks: code.length, requiresResumeExample: required } };
      } catch {
        return { passed: false, score: 0, details: 'Invalid or unclosed code block' };
      }
    },
  };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function evaluationPassed(report: EvalReport): boolean {
  return report.cases.every((result) => result.scores.every((score) => score.status === 'passed')
    && (result.caseId === 'api-unavailable' ? result.status === 'failed' : result.status === 'completed'));
}

export async function evaluateResearch(model: ModelGateway, documentsPath: string, signal?: AbortSignal) {
  // runEvaluation is sequential. Capture actual tool replies, without adding
  // result contents to the core event journal or exposing them in the report.
  const evidence = new Map<string, readonly AgentMessage[]>();
  const observed: ModelGateway = {
    ...model,
    stream(input) {
      const question = input.messages.find((message) => message.role === 'user')?.content;
      if (question) evidence.set(question, input.messages);
      return model.stream(input);
    },
  };
  const app = createFevex({ models: { default: observed }, agents: [researchAgent], connections: createResearchFixtures(documentsPath) });
  return runEvaluation({
    app, suiteName: 'research', targetVersion: model.metadata?.model ?? 'scripted-v1', agentName: researchAgent.name,
    dataset: researchDataset, scorers: [toolSelectionScorer({ ordered: false }), groundingScorer(evidence), codeScorer(evidence)], signal,
  });
}
