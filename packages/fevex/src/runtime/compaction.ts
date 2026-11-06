import type { AgentMessage, ExecutionContext, ToolSpec } from '../core';
import type { ContextBudget } from '../agents';
import type { ModelGateway } from '../models';
import type { SessionId } from './run-store';

/** Estimates the input tokens of messages and tool definitions. */
export type ContextTokenEstimator = (
  input: { messages: AgentMessage[]; tools?: ToolSpec[] },
) => number;

export interface ContextCompactionInput {
  agentName: string;
  sessionId: SessionId;
  /** Older turns and earlier tool batches; system prefix, current request and latest batch are preserved. */
  messages: AgentMessage[];
  tools?: ToolSpec[];
  /** Estimated tokens of the whole prompt before compaction. */
  estimatedTokens: number;
  /** Soft budget for the messages returned by the compactor. */
  targetTokens: number;
  /** Hard model context window. */
  contextWindow: number;
  step: number;
  context?: ExecutionContext;
  signal?: AbortSignal;
  /** Estimates messages with the runtime's configured estimator. */
  estimateTokens(messages: AgentMessage[]): number;
}

/** Returns the replacement for the older conversation messages. */
export interface ContextCompactor {
  compact(input: ContextCompactionInput): AgentMessage[] | Promise<AgentMessage[]>;
}

export interface ContextCompactionOptions {
  /** Defaults to a deterministic digest compactor. */
  compactor?: ContextCompactor;
  /** Defaults to a character-based estimate. */
  estimateTokens?: ContextTokenEstimator;
  /** Redacts the summary before it enters the context.compacted event. */
  redactSummary?: (summary: string) => string;
}

/** Cumulative runtime counters for automatic context compaction. */
export interface ContextCompactionStats {
  compactions: number;
  removedMessages: number;
  estimatedTokens: number;
  compactedTokens: number;
  savedTokens: number;
}

export interface ResolvedContextBudget {
  contextWindow: number;
  reserveOutputTokens: number;
  compactAt: number;
  targetTokens: number;
  safetyFactor: number;
}

/** Validates a context budget and fills in defaults. */
export function resolveContextBudget(
  budget: ContextBudget | undefined,
  label: string,
): ResolvedContextBudget | undefined {
  if (budget === undefined) return undefined;
  if (!isRecord(budget)) throw new TypeError(`${label} must be an object`);
  const contextWindow = budget.contextWindow;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new TypeError(`${label}.contextWindow must be a positive safe integer`);
  }
  const reserveOutputTokens = budget.reserveOutputTokens ?? 0;
  if (
    !Number.isSafeInteger(reserveOutputTokens)
    || reserveOutputTokens < 0
    || reserveOutputTokens >= contextWindow
  ) {
    throw new TypeError(`${label}.reserveOutputTokens must be a non-negative safe integer below contextWindow`);
  }
  const usable = contextWindow - reserveOutputTokens;
  const compactAt = budget.compactAt ?? 0.8;
  if (typeof compactAt !== 'number' || !Number.isFinite(compactAt) || compactAt <= 0 || compactAt > 1) {
    throw new TypeError(`${label}.compactAt must be greater than 0 and at most 1`);
  }
  const targetTokens = budget.targetTokens
    ?? Math.max(1, Math.floor(usable * Math.min(0.5, compactAt * 0.9)));
  if (!Number.isSafeInteger(targetTokens) || targetTokens <= 0 || targetTokens >= usable) {
    throw new TypeError(`${label}.targetTokens must be a positive safe integer below the usable window`);
  }
  if (targetTokens > Math.floor(usable * compactAt)) {
    throw new TypeError(`${label}.targetTokens must not exceed the compaction threshold`);
  }
  const safetyFactor = budget.safetyFactor ?? 1.1;
  if (
    typeof safetyFactor !== 'number'
    || !Number.isFinite(safetyFactor)
    || safetyFactor < 1
    || safetyFactor > 2
  ) {
    throw new TypeError(`${label}.safetyFactor must be between 1 and 2`);
  }
  return { contextWindow, reserveOutputTokens, compactAt, targetTokens, safetyFactor };
}

/**
 * Rough provider-neutral estimate: about four characters per token plus
 * message and tool framing. Hosts can inject a real tokenizer instead.
 */
export function estimateContextTokens(
  input: { messages: AgentMessage[]; tools?: ToolSpec[] },
): number {
  let characters = 0;
  for (const message of input.messages) {
    characters += message.role.length + message.content.length + 16;
    if (message.name !== undefined) characters += message.name.length;
    if (message.toolCallId !== undefined) characters += message.toolCallId.length;
    if (message.toolCalls !== undefined) {
      characters += JSON.stringify(message.toolCalls).length;
    }
  }
  if (input.tools?.length) characters += JSON.stringify(input.tools).length;
  return Math.max(1, Math.ceil(characters / 4));
}

export interface ModelContextCompactorOptions {
  /** Model used only to summarize older context. */
  model: ModelGateway;
  /** Overrides the built-in summarization instructions. */
  systemPrompt?: string;
  /** Maximum output tokens for the summary. Defaults to 1,024. */
  maxOutputTokens?: number;
}

/**
 * Creates a semantic compactor backed by a model. Use a cheap, fast model and
 * keep it separate from the agent model when possible.
 */
export function createModelContextCompactor(
  options: ModelContextCompactorOptions,
): ContextCompactor {
  const maxOutputTokens = options.maxOutputTokens ?? 1_024;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new TypeError('Model compactor maxOutputTokens must be a positive safe integer');
  }
  return {
    async compact(input) {
      const transcript = input.messages
        .map((message) => {
          const toolCalls = message.toolCalls?.length
            ? `\nTool calls: ${message.toolCalls
                .map((call) => `${call.name}(${JSON.stringify(call.input)})`)
                .join(', ')}`
            : '';
          const name = message.name === undefined ? '' : ` (${message.name})`;
          return `${message.role}${name}: ${message.content}${toolCalls}`;
        })
        .join('\n\n');
      const stream = options.model.stream({
        messages: [
          {
            role: 'system',
            content: options.systemPrompt
              ?? 'You compact conversation history for another agent. Preserve decisions, approvals, constraints, identifiers, tool results and open tasks. Return only the summary.',
          },
          {
            role: 'user',
            content: `Summarize the following conversation in at most ${input.targetTokens} tokens.\n\n${transcript || '(empty)'}`,
          },
        ],
        maxOutputTokens,
        signal: input.signal,
      });
      let deltas = '';
      let output: unknown;
      for await (const event of stream) {
        if (event.type === 'output.delta') deltas += event.delta;
        else output = event.result.output;
      }
      const summary = typeof output === 'string' ? output : deltas;
      if (!summary.trim()) {
        throw new Error('Model context compactor returned an empty summary');
      }
      return [{ role: 'system', content: summary.trim() }];
    },
  };
}

export interface DigestContextCompactorOptions {
  /** Maximum characters kept from one message. Defaults to 400. */
  maxCharsPerMessage?: number;
}

/**
 * Deterministic compactor used when the host does not inject one. It keeps
 * role-aware excerpts of older messages and drops the oldest excerpts first.
 * It never calls a model.
 */
export function createDigestContextCompactor(
  options: DigestContextCompactorOptions = {},
): ContextCompactor {
  const maxChars = options.maxCharsPerMessage ?? 400;
  if (!Number.isSafeInteger(maxChars) || maxChars < 40) {
    throw new TypeError('Digest compactor maxCharsPerMessage must be a safe integer of at least 40');
  }
  return {
    compact(input) {
      if (input.messages.length === 0) {
        return [{ role: 'system', content: '[Compacted earlier conversation]' }];
      }
      let perMessage = maxChars;
      let lines = input.messages.flatMap((message) => digestMessage(message, perMessage));
      while (
        input.estimateTokens([{ role: 'system', content: digestContent(lines, input.messages.length) }])
          > input.targetTokens
        && perMessage > 40
      ) {
        perMessage = Math.max(40, Math.floor(perMessage * 0.7));
        lines = input.messages.flatMap((message) => digestMessage(message, perMessage));
      }
      let selected = lines;
      let content = digestContent(selected, input.messages.length);
      while (
        input.estimateTokens([{ role: 'system', content }]) > input.targetTokens
        && selected.length > 1
      ) {
        selected = selected.slice(1);
        content = digestContent(selected, input.messages.length);
      }
      const limit = Math.max(80, input.targetTokens * 4);
      if (content.length > limit) {
        content = `${content.slice(0, Math.max(0, limit - 1))}…`;
      }
      return [{ role: 'system', content }];
    },
  };
}

function digestContent(lines: readonly string[], totalMessages: number): string {
  const omitted = Math.max(0, totalMessages - lines.length);
  return [
    `[Compacted conversation: ${totalMessages} earlier messages${omitted ? `, ${omitted} omitted` : ''}]`,
    ...lines,
  ].join('\n');
}

function digestMessage(message: AgentMessage, maxChars: number): string[] {
  const content = truncate(message.content, maxChars);
  if (message.role === 'user') {
    return content ? [`User: ${content}`] : [];
  }
  if (message.role === 'assistant') {
    const lines: string[] = [];
    if (content) lines.push(`Assistant: ${content}`);
    for (const call of message.toolCalls ?? []) {
      lines.push(
        `Tool call ${call.name}: ${truncate(JSON.stringify(call.input), Math.min(maxChars, 200))}`,
      );
    }
    return lines;
  }
  if (message.role === 'tool') {
    return content
      ? [`Tool result${message.name === undefined ? '' : ` (${message.name})`}: ${content}`]
      : [];
  }
  return content ? [`System: ${content}`] : [];
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
