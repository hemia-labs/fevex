import { createFevex, defineAgent, defineTool } from 'fevex';
import { fakeModel } from 'fevex/testing';
import { z } from 'zod';

const accountInput = z.object({
  accountId: z.number(),
});

const accountOutput = z.object({
  accountId: z.number(),
  status: z.literal('active'),
});

const getAccount = defineTool({
  name: 'accounts.get',
  description: 'Get an account by ID.',
  inputSchema: accountInput,
  outputSchema: accountOutput,
  execute({ accountId }) {
    return { accountId, status: 'active' };
  },
});

const model = fakeModel(
  {
    toolCalls: [{
      id: 'call-1',
      name: 'accounts.get',
      input: { accountId: 42 },
    }],
  },
  { output: 'Account 42 is active.' },
);

const app = createFevex({
  models: { default: model },
  agents: [defineAgent({
    name: 'support',
    instructions: 'Answer account questions clearly.',
    tools: ['accounts.get'],
    outputSchema: z.string(),
  })],
  tools: [getAccount],
});

const result = await app.runAgent<string, string>('support', {
  input: 'What is the status of account 42?',
});

if (result.output !== 'Account 42 is active.' || model.calls.length !== 2) {
  throw new Error('Basic agent example failed');
}

console.log(result.output);
