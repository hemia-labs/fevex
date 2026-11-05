import { describe, expect, test } from 'bun:test';
import type { AgentMessage } from '../core';
import {
  createDigestContextCompactor,
  estimateContextTokens,
  resolveContextBudget,
} from './compaction';

const message = (role: AgentMessage['role'], content: string): AgentMessage => ({
  role,
  content,
});

describe('context budget', () => {
  test('fills defaults and rejects invalid windows', () => {
    expect(resolveContextBudget({ maxInputTokens: 1_000 }, 'budget')).toEqual({
      maxInputTokens: 1_000,
      reserveOutputTokens: 0,
      compactAt: 0.8,
      targetTokens: 500,
    });
    expect(() => resolveContextBudget({ maxInputTokens: 0 }, 'budget')).toThrow('maxInputTokens');
    expect(() =>
      resolveContextBudget({ maxInputTokens: 1_000, targetTokens: 900 }, 'budget'),
    ).toThrow('targetTokens');
    expect(() =>
      resolveContextBudget({ maxInputTokens: 1_000, compactAt: 1.5 }, 'budget'),
    ).toThrow('compactAt');
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
      maxInputTokens: 1_000,
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
