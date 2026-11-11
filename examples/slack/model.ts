import { type ModelGateway } from '@fevex/core';
import { createDeepSeek } from '@fevex/deepseek';
import { createOpenAI } from '@fevex/openai';

function accountAnswer(content: string): string {
  try {
    const value = JSON.parse(content) as {
      found?: boolean;
      accountId?: number;
      accounts?: Array<{ id: number; name: string; status: string; plan: string }>;
    };
    if (value.accounts) {
      return `Demo accounts: ${value.accounts.map((account) => `${account.id} (${account.name}, ${account.status}, ${account.plan})`).join(', ')}.`;
    }
    if (value.found === false) return `Account ${value.accountId ?? ''} was not found.`.trim();
    if (value.found) {
      const account = value as unknown as { id: number; name: string; status: string; plan: string };
      return `Account ${account.id} (${account.name}) is ${account.status} on the ${account.plan} plan.`;
    }
  } catch {
    // Fall through to the generic tool result.
  }
  return 'The account service returned a result.';
}

export function createScriptedModel(): ModelGateway {
  return {
    async *stream(input) {
      const tool = [...input.messages].reverse().find((message) => message.role === 'tool');
      if (tool) {
        const output = accountAnswer(tool.content);
        yield { type: 'output.delta', delta: output };
        yield { type: 'completed', result: { output } };
        return;
      }
      const user = [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const accountId = /\b(\d+)\b/.exec(user)?.[1];
      const toolCalls = accountId
        ? [{ id: 'account-lookup', name: 'accounts__accounts_get', input: { accountId: Number(accountId) } }]
        : /list|account|cuenta/i.test(user)
          ? [{ id: 'account-list', name: 'accounts__accounts_list', input: {} }]
          : [];
      if (!toolCalls.length) {
        const output = 'Which numeric account ID do you want to check?';
        yield { type: 'output.delta', delta: output };
        yield { type: 'completed', result: { output } };
        return;
      }
      yield { type: 'completed', result: { toolCalls } };
    },
  };
}

export function createSwitchableModel(initial: ModelGateway) {
  let current = initial;
  return {
    gateway: {
      stream: (input: Parameters<ModelGateway['stream']>[0]) => current.stream(input),
      get metadata() { return current.metadata; },
      get stateCodec() { return current.stateCodec; },
    } satisfies ModelGateway,
    use(model: ModelGateway) {
      current = model;
    },
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

export function createEnvironmentModel(): { model: ModelGateway; provider: string } {
  const provider = (process.env.FEVEX_PROVIDER ?? 'scripted').toLowerCase();
  if (provider === 'scripted') return { model: createScriptedModel(), provider };
  const modelId = required('FEVEX_MODEL');
  if (provider === 'openai') {
    return {
      provider,
      model: createOpenAI({ apiKey: required('OPENAI_API_KEY'), schemaPolicy: 'best-effort' })(modelId),
    };
  }
  if (provider === 'deepseek') {
    return {
      provider,
      model: createDeepSeek({ apiKey: required('DEEPSEEK_API_KEY'), schemaPolicy: 'best-effort' })(modelId),
    };
  }
  throw new Error('FEVEX_PROVIDER must be scripted, openai or deepseek');
}
