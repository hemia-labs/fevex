import type { ToolDefinition } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { schema } from '../internal/schema';
import { createBrowserTool } from './factory';

export type CloseInput = Record<string, never>;

const closeSchema = schema<CloseInput>(
  (value) => {
    if (value === undefined || value === null) return { value: {} };
    if (typeof value !== 'object') return { issues: [{ message: 'Expected an object' }] };
    return { value: {} };
  },
  { type: 'object', additionalProperties: false },
);

export function closeTool(config: ResolvedConfig): ToolDefinition {
  return createBrowserTool<CloseInput>(
    {
      name: 'browser__close',
      description: 'Close the browser session for this run.',
      risk: 'write',
      inputSchema: closeSchema,
      command: 'close',
      positional: () => [],
    },
    config,
  );
}
