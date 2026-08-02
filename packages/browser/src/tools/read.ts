import type { ToolDefinition } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { schema } from '../internal/schema';
import { createBrowserTool } from './factory';

export interface ReadInput {
  /** Optional element ref; defaults to the whole page. */
  ref?: string;
}

const readSchema = schema<ReadInput>(
  (value) => {
    if (value === undefined || value === null) return { value: {} };
    if (typeof value !== 'object') return { issues: [{ message: 'Expected an object' }] };
    const ref = (value as Record<string, unknown>).ref;
    if (ref !== undefined && typeof ref !== 'string') {
      return { issues: [{ message: '"ref" must be a string' }] };
    }
    return { value: ref === undefined ? {} : { ref } };
  },
  {
    type: 'object',
    properties: { ref: { type: 'string', description: 'Optional element ref, e.g. @e1.' } },
    additionalProperties: false,
  },
);

export function readTool(config: ResolvedConfig): ToolDefinition {
  return createBrowserTool<ReadInput>(
    {
      name: 'browser__read',
      description: 'Read the text content of the page or a given element ref.',
      risk: 'read',
      inputSchema: readSchema,
      command: 'read',
      positional: (input) => (input.ref ? [input.ref] : []),
    },
    config,
  );
}
