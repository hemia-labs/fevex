import type { ToolDefinition } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { schema } from '../internal/schema';
import { createBrowserTool } from './factory';

export interface WaitInput {
  /** Condition to wait for (selector, ref or text). Defaults to network idle. */
  condition?: string;
  /** Optional wait timeout in milliseconds. */
  timeoutMs?: number;
}

const waitSchema = schema<WaitInput>(
  (value) => {
    if (value === undefined || value === null) return { value: {} };
    if (typeof value !== 'object') return { issues: [{ message: 'Expected an object' }] };
    const record = value as Record<string, unknown>;
    if (record.condition !== undefined && typeof record.condition !== 'string') {
      return { issues: [{ message: '"condition" must be a string' }] };
    }
    if (
      record.timeoutMs !== undefined &&
      (!Number.isInteger(record.timeoutMs) || (record.timeoutMs as number) < 1)
    ) {
      return { issues: [{ message: '"timeoutMs" must be a positive integer' }] };
    }
    const result: WaitInput = {};
    if (record.condition !== undefined) result.condition = record.condition as string;
    if (record.timeoutMs !== undefined) result.timeoutMs = record.timeoutMs as number;
    return { value: result };
  },
  {
    type: 'object',
    properties: {
      condition: { type: 'string', description: 'Selector, ref or text to wait for.' },
      timeoutMs: { type: 'integer', minimum: 1, description: 'Wait timeout in ms.' },
    },
    additionalProperties: false,
  },
);

export function waitTool(config: ResolvedConfig): ToolDefinition {
  return createBrowserTool<WaitInput>(
    {
      name: 'browser__wait',
      description: 'Wait for a condition or for the page to settle.',
      risk: 'write',
      inputSchema: waitSchema,
      command: 'wait',
      positional: (input) => (input.condition ? [input.condition] : []),
      extraArgs: (input) => (input.timeoutMs ? ['--timeout', String(input.timeoutMs)] : []),
    },
    config,
  );
}
