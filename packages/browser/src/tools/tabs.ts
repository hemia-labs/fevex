import type { ToolDefinition } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { schema } from '../internal/schema';
import { createBrowserTool } from './factory';

const TAB_ACTIONS = ['list', 'new', 'select', 'close'] as const;
type TabAction = (typeof TAB_ACTIONS)[number];

export interface TabsInput {
  action: TabAction;
  /** Target tab id for select/close. */
  target?: string;
}

const tabsSchema = schema<TabsInput>(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return { issues: [{ message: 'Expected an object' }] };
    }
    const record = value as Record<string, unknown>;
    if (!TAB_ACTIONS.includes(record.action as TabAction)) {
      return { issues: [{ message: `"action" must be one of ${TAB_ACTIONS.join(', ')}` }] };
    }
    if (record.target !== undefined && typeof record.target !== 'string') {
      return { issues: [{ message: '"target" must be a string' }] };
    }
    const result: TabsInput = { action: record.action as TabAction };
    if (record.target !== undefined) result.target = record.target as string;
    return { value: result };
  },
  {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...TAB_ACTIONS], description: 'Tab operation.' },
      target: { type: 'string', description: 'Tab id for select/close.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
);

export function tabsTool(config: ResolvedConfig): ToolDefinition {
  return createBrowserTool<TabsInput>(
    {
      name: 'browser__tabs',
      description: 'List, open, select or close browser tabs.',
      risk: 'write',
      inputSchema: tabsSchema,
      command: 'tabs',
      positional: (input) => [input.action, ...(input.target ? [input.target] : [])],
    },
    config,
  );
}
