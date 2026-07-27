import { createDeepSeek } from '@fevex/deepseek';
import { createFevex, defineAgent, defineTool } from '@fevex/core';
import { z } from 'zod';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.log('Set DEEPSEEK_API_KEY to run the DeepSeek example.');
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
    default: createDeepSeek({
      apiKey,
      schemaPolicy: 'best-effort',
    })('deepseek-v4-flash'),
  },
  agents: [defineAgent({
    name: 'support',
    instructions: 'Answer account questions clearly. When returning structured data, return valid json.',
    tools: ['accounts_get'],
    outputSchema: z.object({ answer: z.string() }),
  })],
  tools: [getAccount],
});

const result = await app.runAgent<string, { answer: string }>('support', {
  input: 'What is the status of account 42?',
});

console.log(result.output.answer);
