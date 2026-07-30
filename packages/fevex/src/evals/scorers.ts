import type { EvalScorer } from './types';
import { serializeCanonical } from './canonical-json';

export function exactOutputScorer(id = 'output.exact'): EvalScorer {
  return {
    id,
    score({ testCase, output }) {
      if (testCase.expected?.output === undefined) {
        return { skipped: true, reason: 'No expected output' };
      }
      const passed = serializeCanonical(output) === serializeCanonical(testCase.expected.output);
      return { passed, score: passed ? 1 : 0 };
    },
  };
}

export function toolSelectionScorer(
  options: { id?: string; ordered?: boolean } = {},
): EvalScorer {
  return {
    id: options.id ?? 'tools.selected',
    score({ testCase, tools }) {
      const expected = testCase.expected?.tools;
      if (!expected) return { skipped: true, reason: 'No expected tools' };
      const passed = options.ordered === false
        ? [...tools].sort().join('\0') === [...expected].sort().join('\0')
        : tools.join('\0') === expected.join('\0');
      return { passed, score: passed ? 1 : 0 };
    },
  };
}

export function forbiddenToolsScorer(
  tools: readonly string[],
  id = 'tools.forbidden',
): EvalScorer {
  const forbidden = new Set(tools);
  return {
    id,
    score(context) {
      const selected = context.tools.filter((tool) => forbidden.has(tool));
      return {
        passed: selected.length === 0,
        score: selected.length ? 0 : 1,
        ...(selected.length ? { details: { selected } } : {}),
      };
    },
  };
}

export function maxLatencyScorer(maxMs: number, id = 'latency.max'): EvalScorer {
  if (!Number.isFinite(maxMs) || maxMs < 0) throw new TypeError('maxMs must be non-negative');
  return {
    id,
    score({ latencyMs }) {
      return {
        passed: latencyMs <= maxMs,
        score: latencyMs <= maxMs ? 1 : 0,
        details: { actualMs: latencyMs, maxMs },
      };
    },
  };
}

export function maxTokensScorer(
  limits: { input?: number; output?: number; total?: number },
  id = 'tokens.max',
): EvalScorer {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} token limit is invalid`);
  }
  return {
    id,
    score({ usage }) {
      if (!usage) return { passed: false, score: 0, details: 'Model usage is unavailable' };
      const passed =
        (limits.input === undefined || (usage.inputTokens ?? Infinity) <= limits.input) &&
        (limits.output === undefined || (usage.outputTokens ?? Infinity) <= limits.output) &&
        (limits.total === undefined || (usage.totalTokens ?? Infinity) <= limits.total);
      return {
        passed,
        score: passed ? 1 : 0,
        details: {
          usage: {
            ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
            ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
            ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
          },
          limits: {
            ...(limits.input === undefined ? {} : { input: limits.input }),
            ...(limits.output === undefined ? {} : { output: limits.output }),
            ...(limits.total === undefined ? {} : { total: limits.total }),
          },
        },
      };
    },
  };
}

export function maxCostScorer(
  maxAmount: number,
  currency: string,
  id = 'cost.max',
): EvalScorer {
  if (!Number.isFinite(maxAmount) || maxAmount < 0) {
    throw new TypeError('maxAmount must be non-negative');
  }
  if (!currency.trim()) throw new TypeError('currency must be non-empty');
  return {
    id,
    score({ cost }) {
      if (!cost) return { passed: false, score: 0, details: 'Cost is unavailable' };
      const passed = cost.currency === currency && cost.amount <= maxAmount;
      return {
        passed,
        score: passed ? 1 : 0,
        details: {
          actual: { amount: cost.amount, currency: cost.currency },
          maximum: { amount: maxAmount, currency },
        },
      };
    },
  };
}
