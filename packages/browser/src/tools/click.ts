import type { ToolDefinition } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { requireString, schema } from '../internal/schema';
import { createBrowserTool } from './factory';

export interface ClickInput {
  ref: string;
}

const clickSchema = schema<ClickInput>(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return { issues: [{ message: 'Expected an object' }] };
    }
    const ref = requireString((value as Record<string, unknown>).ref, 'ref');
    if (ref.issues) return { issues: ref.issues };
    return { value: { ref: ref.value } };
  },
  {
    type: 'object',
    properties: { ref: { type: 'string', description: 'Element ref to click, e.g. @e1.' } },
    required: ['ref'],
    additionalProperties: false,
  },
);

export function clickTool(config: ResolvedConfig): ToolDefinition {
  return createBrowserTool<ClickInput>(
    {
      name: 'browser__click',
      description: 'Click an element by ref.',
      risk: 'write',
      approval: 'required',
      inputSchema: clickSchema,
      command: 'click',
      positional: (input) => [input.ref],
    },
    config,
  );
}
