import { createOpenAI } from '@fevex/openai';
import { createFevex, defineAgent, defineTool } from '@fevex/core';
import { z } from 'zod';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log('Set OPENAI_API_KEY to run the OpenAI example.');
  process.exit(0);
}

const accountInput = z.object({
  accountId: z.number(),
});

const accountOutput = z.object({
  accountId: z.number(),
  status: z.literal('active'),
});

const getAccount = defineTool({
  name: 'accounts_get',
  description: 'Get an account by ID.',
  inputSchema: accountInput,
  outputSchema: accountOutput,
  execute({ accountId }) {
    return { accountId, status: 'active' };
  },
});

const app = createFevex({
  models: {
    default: createOpenAI({
      apiKey,
      organization: process.env.OPENAI_ORG_ID,
      project: process.env.OPENAI_PROJECT_ID,
    })('gpt-5.6'),
  },
  agents: [defineAgent({
    name: 'support',
    instructions: 'Answer account questions clearly.',
    tools: ['accounts_get'],
    outputSchema: z.object({ answer: z.string() }),
  })],
  tools: [getAccount],
});

const result = await app.runAgent<string, { answer: string }>('support', {
  input: 'What is the status of account 42?',
});

console.log(result.output.answer);
