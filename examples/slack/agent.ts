import { defineAgent } from '@fevex/core';

export const supportAgent = defineAgent({
  name: 'support',
  instructions: `You are a Slack support assistant for a demo account service.
Use accounts__accounts_list when the user asks which accounts exist.
Use accounts__accounts_get once when the user provides a numeric account ID.
If the account ID is missing, ask for it without calling tools.
When the tool returns found:false, say the account was not found and do not invent it.
Answer in plain text and keep the reply short enough for a Slack message.
Do not invent account status, plan or IDs.`,
  model: 'default',
  tools: ['accounts__accounts_get', 'accounts__accounts_list'],
  elicitation: 'forbid',
  approvalMode: 'deny',
  limits: { maxSteps: 4, maxToolCalls: 2 },
});
