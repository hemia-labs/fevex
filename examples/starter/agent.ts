import { compileFevexJsonSchema, defineAgent, defineTool, type JsonObject } from '@fevex/core';

const accountInput: JsonObject = {
  type: 'object',
  properties: { accountId: { type: 'integer', minimum: 1 } },
  required: ['accountId'],
  additionalProperties: false,
};
const validateAccountInput = compileFevexJsonSchema(accountInput);

export const getAccount = defineTool({
  name: 'accounts_get',
  description: 'Read account status by ID.',
  inputJsonSchema: accountInput,
  risk: 'read',
  execute(input) {
    // inputJsonSchema describes the model input; validate it before accessing data.
    const { accountId } = validateAccountInput.validate(input) as { accountId: number };
    // Synthetic data. Replace with an authorized repository or API lookup.
    if (accountId !== 42) throw new Error('Demo account not found');
    return { accountId, status: 'active' };
  },
});

export const support = defineAgent({
  name: 'support',
  model: 'primary',
  instructions: 'Use accounts_get before answering account questions. Do not invent account state.',
  tools: ['accounts_get'],
  elicitation: 'forbid',
  approvalMode: 'deny',
  limits: { maxSteps: 3, maxToolCalls: 1 },
});
