import type { ToolDefinition } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { schema } from '../internal/schema';
import { createBrowserTool } from './factory';

export interface SnapshotInput {
  /** Optional CSS/text scope; defaults to the whole page. */
  scope?: string;
}

const snapshotSchema = schema<SnapshotInput>(
  (value) => {
    if (value === undefined || value === null) return { value: {} };
    if (typeof value !== 'object') return { issues: [{ message: 'Expected an object' }] };
    const scope = (value as Record<string, unknown>).scope;
    if (scope !== undefined && typeof scope !== 'string') {
      return { issues: [{ message: '"scope" must be a string' }] };
    }
    return { value: scope === undefined ? {} : { scope } };
  },
  {
    type: 'object',
    properties: { scope: { type: 'string', description: 'Optional element scope.' } },
    additionalProperties: false,
  },
);

export function snapshotTool(config: ResolvedConfig): ToolDefinition {
  return createBrowserTool<SnapshotInput>(
    {
      name: 'browser__snapshot',
      description: 'Capture an accessibility snapshot with stable element refs.',
      risk: 'read',
      inputSchema: snapshotSchema,
      command: 'snapshot',
      positional: (input) => ['--refs', ...(input.scope ? [input.scope] : [])],
    },
    config,
  );
}
