import type { StandardSchemaV1 } from '@standard-schema/spec';
import { defineAgent } from './agents';
import { defineTool } from './tools';

declare const inputSchema: StandardSchemaV1<unknown, { accountId: number }>;
declare const outputSchema: StandardSchemaV1<unknown, { status: string }>;

defineAgent({
  name: 'support',
  instructions: 'Answer clearly.',
  outputSchema,
  limits: { maxSteps: 1 },
});

defineTool({
  name: 'accounts.get',
  inputSchema,
  outputSchema,
  execute(input) {
    input.accountId satisfies number;
    return { status: 'active' };
  },
});

defineAgent({
  name: 'invalid',
  instructions: 'Answer clearly.',
  // @ts-expect-error Unknown agent fields are rejected.
  instruction: 'Typo',
});

defineTool({
  name: 'invalid',
  execute() {},
  // @ts-expect-error Unknown tool fields are rejected.
  schema: inputSchema,
});
