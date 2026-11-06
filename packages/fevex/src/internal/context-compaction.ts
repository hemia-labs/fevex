import type { AgentMessage, ExecutionContext, ToolSpec } from '../core';
import { FevexRunError } from '../run-error';
import { abortable } from './run-support';
import type { ContextCompactor, ResolvedContextBudget, SessionId } from '../runtime';

/** Maximum summary characters copied into the context.compacted event. */
export const MAX_COMPACTION_EVENT_SUMMARY_CHARS = 4_000;

export interface CompactContextInput {
  runId: string;
  agentName: string;
  sessionId: SessionId;
  messages: AgentMessage[];
  tools: ToolSpec[];
  contextBudget: ResolvedContextBudget;
  compactor: ContextCompactor;
  estimateTokens: (input: { messages: AgentMessage[]; tools?: ToolSpec[] }) => number;
  step: number;
  context?: ExecutionContext;
  signal?: AbortSignal;
  /** When false, only enforce the hard budget and never summarize again. */
  allowCompaction?: boolean;
}

export interface CompactedContext {
  messages: AgentMessage[];
  removedMessages: number;
  estimatedTokens: number;
  compactedTokens: number;
  summary: string;
}

export async function compactContext(
  input: CompactContextInput,
): Promise<CompactedContext | undefined> {
  const estimateWith = (messages: AgentMessage[], includeTools: boolean): number => {
    const value = input.estimateTokens({
      messages,
      ...(includeTools ? { tools: input.tools } : {}),
    });
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('Context token estimator must return a non-negative finite number');
    }
    return Math.ceil(value * input.contextBudget.safetyFactor);
  };
  const estimate = (messages: AgentMessage[]): number => estimateWith(messages, true);
  const estimated = estimate(input.messages);
  const usable = input.contextBudget.contextWindow - input.contextBudget.reserveOutputTokens;
  const threshold = Math.floor(usable * input.contextBudget.compactAt);

  if (input.allowCompaction === false || estimated <= threshold) {
    if (estimated > usable) {
      throw new FevexRunError(
        'CONTEXT_BUDGET_EXCEEDED',
        `Agent "${input.agentName}" context budget exceeded: ${estimated} tokens > ${usable} usable${input.allowCompaction === false ? ' after compaction' : ''}.`,
        input.runId,
      );
    }
    return undefined;
  }

  const split = splitContextForCompaction(input.messages);
  if (split === undefined || split.compactable.length === 0) {
    if (estimated > usable) {
      throw new FevexRunError(
        'CONTEXT_BUDGET_EXCEEDED',
        `Agent "${input.agentName}" context budget exceeded: ${estimated} tokens > ${usable} usable. The preserved system prefix and current turn cannot be compacted further.`,
        input.runId,
      );
    }
    return undefined;
  }

  const preservedTokens = estimate([...split.prefix, ...split.currentTurn]);
  const available = Math.max(
    1,
    Math.min(input.contextBudget.targetTokens, usable - 1) - preservedTokens,
  );
  const compactedMessages = validateCompactedMessages(
    await abortable(
      () =>
        input.compactor.compact({
          agentName: input.agentName,
          sessionId: input.sessionId,
          messages: split.compactable,
          tools: input.tools,
          estimatedTokens: estimated,
          targetTokens: available,
          contextWindow: input.contextBudget.contextWindow,
          step: input.step,
          ...(input.context === undefined ? {} : { context: input.context }),
          signal: input.signal,
          estimateTokens: (messages) => estimateWith(messages, false),
        }),
      input.signal,
    ),
  );
  const messages = [...split.prefix, ...compactedMessages, ...split.currentTurn];
  const compactedTokens = estimate(messages);
  if (compactedTokens > usable) {
    throw new FevexRunError(
      'CONTEXT_BUDGET_EXCEEDED',
      `Agent "${input.agentName}" context budget exceeded after compaction: ${compactedTokens} tokens > ${usable} usable. The preserved system prefix and current turn cannot be compacted further.`,
      input.runId,
    );
  }
  return {
    messages,
    removedMessages: split.compactable.length,
    estimatedTokens: estimated,
    compactedTokens,
    summary: compactedMessages.map((message) => message.content).join('\n\n'),
  };
}

interface SplitContext {
  /** System instructions, skills, context and memory. */
  prefix: AgentMessage[];
  /** Current request and the latest completed tool batch. */
  currentTurn: AgentMessage[];
  /** Older history and earlier tool batches in the current turn. */
  compactable: AgentMessage[];
}

function splitContextForCompaction(messages: AgentMessage[]): SplitContext | undefined {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return undefined;

  let lastToolBatch = -1;
  for (let index = messages.length - 1; index > lastUser; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      lastToolBatch = index;
      break;
    }
  }

  const prefix = messages.filter((message) => message.role === 'system');
  const currentTurn = (
    lastToolBatch === -1
      ? messages.slice(lastUser)
      : [messages[lastUser]!, ...messages.slice(lastToolBatch)]
  ).filter((message) => message.role !== 'system');
  const preserved = new Set([...prefix, ...currentTurn]);
  return {
    prefix,
    currentTurn,
    compactable: messages.filter(
      (message) => message.role !== 'system' && !preserved.has(message),
    ),
  };
}

function validateCompactedMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Context compactor must return at least one message');
  }
  const roles = new Set(['system', 'user', 'assistant', 'tool']);
  for (const [index, message] of value.entries()) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      throw new TypeError(`Context compactor message at index ${index} must be an object`);
    }
    const record = message as Record<string, unknown>;
    if (typeof record.role !== 'string' || !roles.has(record.role)) {
      throw new TypeError(`Context compactor message at index ${index} has an invalid role`);
    }
    if (typeof record.content !== 'string') {
      throw new TypeError(`Context compactor message at index ${index} must have string content`);
    }
    if (record.toolCalls !== undefined && !Array.isArray(record.toolCalls)) {
      throw new TypeError(`Context compactor message at index ${index} has invalid toolCalls`);
    }
  }
  return value as AgentMessage[];
}
