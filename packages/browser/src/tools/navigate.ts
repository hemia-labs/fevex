import type { ToolDefinition } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { assertDomainAllowed, withAllowedDomains } from '../internal/cli';
import { requireString, schema } from '../internal/schema';
import { createBrowserTool } from './factory';

export interface NavigateInput {
  url: string;
}

const navigateSchema = schema<NavigateInput>(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return { issues: [{ message: 'Expected an object' }] };
    }
    const url = requireString((value as Record<string, unknown>).url, 'url');
    if (url.issues) return { issues: url.issues };
    return { value: { url: url.value } };
  },
  {
    type: 'object',
    properties: { url: { type: 'string', description: 'Absolute URL to open.' } },
    required: ['url'],
    additionalProperties: false,
  },
);

export function navigateTool(config: ResolvedConfig): ToolDefinition {
  return createBrowserTool<NavigateInput>(
    {
      name: 'browser__navigate',
      description: 'Open a URL within the allowed domains.',
      risk: 'read',
      inputSchema: navigateSchema,
      command: 'navigate',
      guard: (input) => assertDomainAllowed(input.url, config),
      positional: (input) => [input.url],
      extraArgs: (_input, cfg) => withAllowedDomains([], cfg),
    },
    config,
  );
}
