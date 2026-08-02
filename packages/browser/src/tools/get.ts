import type { ToolDefinition } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { requireString, schema } from '../internal/schema';
import { createBrowserTool } from './factory';

export interface GetInput {
  ref: string;
  attribute: string;
}

const getSchema = schema<GetInput>(
  (value) => {
    if (typeof value !== 'object' || value === null) {
      return { issues: [{ message: 'Expected an object' }] };
    }
    const record = value as Record<string, unknown>;
    const ref = requireString(record.ref, 'ref');
    if (ref.issues) return { issues: ref.issues };
    const attribute = requireString(record.attribute, 'attribute');
    if (attribute.issues) return { issues: attribute.issues };
    return { value: { ref: ref.value, attribute: attribute.value } };
  },
  {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'Element ref, e.g. @e1.' },
      attribute: { type: 'string', description: 'Attribute or property name to read.' },
    },
    required: ['ref', 'attribute'],
    additionalProperties: false,
  },
);

export function getTool(config: ResolvedConfig): ToolDefinition {
  return createBrowserTool<GetInput>(
    {
      name: 'browser__get',
      description: 'Get an attribute or property value from an element ref.',
      risk: 'read',
      inputSchema: getSchema,
      command: 'get',
      positional: (input) => [input.ref, input.attribute],
    },
    config,
  );
}
