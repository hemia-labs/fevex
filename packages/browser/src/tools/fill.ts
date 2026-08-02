import type { ToolDefinition } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { requireString, schema } from '../internal/schema';
import { createBrowserTool } from './factory';

export interface FillInput {
  ref: string;
  value: string;
}

const fillSchema = schema<FillInput>(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return { issues: [{ message: 'Expected an object' }] };
    }
    const record = value as Record<string, unknown>;
    const ref = requireString(record.ref, 'ref');
    if (ref.issues) return { issues: ref.issues };
    if (typeof record.value !== 'string') {
      return { issues: [{ message: '"value" must be a string' }] };
    }
    return { value: { ref: ref.value, value: record.value } };
  },
  {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'Input element ref, e.g. @e1.' },
      value: { type: 'string', description: 'Text to type into the field.' },
    },
    required: ['ref', 'value'],
    additionalProperties: false,
  },
);

export function fillTool(config: ResolvedConfig): ToolDefinition {
  return createBrowserTool<FillInput>(
    {
      name: 'browser__fill',
      description: 'Fill an input element by ref with a value.',
      risk: 'write',
      approval: 'required',
      inputSchema: fillSchema,
      command: 'fill',
      positional: (input) => [input.ref, input.value],
    },
    config,
  );
}
