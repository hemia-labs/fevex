import { describe, expect, test } from 'bun:test';
import type { AgentMessage } from '../core';
import { fakeModel } from '../testing';
import {
  createDigestContextCompactor,
  createModelContextCompactor,
  estimateContextTokens,
  resolveContextBudget,
} from './compaction';

const message = (role: AgentMessage['role'], content: string): AgentMessage => ({
  role,
  content,
});

describe('context budget', () => {
  test('fills defaults and rejects invalid windows', () => {
    expect(resolveContextBudget({ contextWindow: 1_000 }, 'budget')).toEqual({
      contextWindow: 1_000,
      reserveOutputTokens: 0,
      compactAt: 0.8,
      targetTokens: 500,
      safetyFactor: 1.1,
    });
    expect(() => resolveContextBudget({ contextWindow: 0 }, 'budget')).toThrow('contextWindow');
    expect(() =>
      resolveContextBudget({ contextWindow: 1_000, targetTokens: 900 }, 'budget'),
    ).toThrow('targetTokens');
    expect(() =>
      resolveContextBudget({ contextWindow: 1_000, compactAt: 1.5 }, 'budget'),
    ).toThrow('compactAt');
    expect(() =>
      resolveContextBudget({ contextWindow: 1_000, safetyFactor: 0.5 }, 'budget'),
    ).toThrow('safetyFactor');
  });

  test('estimates messages and tools', () => {
    const messages = [message('user', 'x'.repeat(400))];
    const withoutTools = estimateContextTokens({ messages });
    expect(withoutTools).toBeGreaterThan(100);
    expect(
      estimateContextTokens({
        messages,
        tools: [{ name: 'lookup', description: 'Look up.', inputSchema: { type: 'object' } }],
      }),
    ).toBeGreaterThan(withoutTools);
  });
});

describe('model context compactor', () => {
  test('summarizes older messages with the configured model', async () => {
    const model = fakeModel({ output: 'MODEL SUMMARY' });
    const compactor = createModelContextCompactor({ model });
    const result = await compactor.compact({
      agentName: 'support',
      sessionId: 'session-1',
      messages: [message('user', 'old request'), message('assistant', 'old answer')],
      estimatedTokens: 500,
      targetTokens: 100,
      contextWindow: 1_000,
      step: 1,
      estimateTokens: () => 50,
    });
    expect(result).toEqual([{ role: 'system', content: 'MODEL SUMMARY' }]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.tools).toBeUndefined();
    expect(model.calls[0]!.messages.at(-1)?.content).toContain('old request');
  });
});

describe('digest context compactor', () => {
  test('keeps recent excerpts and stays near the target', async () => {
    const compactor = createDigestContextCompactor({ maxCharsPerMessage: 80 });
    const messages = Array.from({ length: 20 }, (_, index) =>
      message(index % 2 === 0 ? 'user' : 'assistant', `message-${index} ${'x'.repeat(120)}`),
    );
    const result = await compactor.compact({
      agentName: 'support',
      sessionId: 'session-1',
      messages,
      estimatedTokens: 1_000,
      targetTokens: 80,
      contextWindow: 1_000,
      step: 1,
      estimateTokens: (items) => Math.ceil(items.reduce((sum, item) => sum + item.content.length, 0) / 4),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('system');
    expect(result[0]!.content).toContain('Compacted conversation');
    expect(result[0]!.content).toContain('message-19');
    expect(result[0]!.content).not.toContain('message-0');
  });
});
