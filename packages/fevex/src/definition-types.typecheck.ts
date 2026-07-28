import type { StandardSchemaV1 } from '@standard-schema/spec';
import { defineAgent } from './agents';
import {
  type ChannelAdapter,
  ChannelError,
  handleChannelInput,
  type ChannelMessage,
  type ChannelRunResult,
} from './channels';
import {
  PROVIDER_REASONING_UNSUPPORTED,
  PROVIDER_SCHEMA_UNSUPPORTED,
  type AgentEvent,
} from './core';
import {
  createFevex,
  FevexConfigurationError,
  InMemoryRunStore,
  type AgentRun,
  type FevexConfigurationErrorCode,
  type RunRecord,
  type Session,
} from './index';
import { defineTool } from './tools';
import type { ModelInput, ModelResult } from './models';
import {
  createFevexHttpClient,
  createFevexHttpHandler,
  FEVEX_HTTP_PROTOCOL_VERSION,
} from './http';
import {
  createMemoryContextProvider,
  defineContextProvider,
  defineSkill,
  InMemoryMemoryStore,
  type ContextBlock,
  type KnowledgeContext,
  type MemoryRecord,
} from './knowledge';

declare const inputSchema: StandardSchemaV1<unknown, { accountId: number }>;
declare const outputSchema: StandardSchemaV1<unknown, { status: string }>;

defineAgent({
  name: 'support',
  instructions: 'Answer clearly.',
  outputSchema,
  limits: { maxSteps: 1 },
});

defineTool({
  name: 'accounts_get',
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

declare const event: AgentEvent;

if (event.type === 'tool.started') {
  event.payload.step satisfies number;
  event.payload.toolCallId satisfies string;
}

if (event.type === 'run.cancelled') {
  event.payload.reason satisfies 'aborted' | 'timeout' | 'approval_rejected';
}

if (event.type === 'model.output.delta') {
  event.payload.step satisfies number;
  event.payload.delta satisfies string;
}

if (event.type === 'run.started') {
  event.payload satisfies undefined;
}

declare const configurationError: FevexConfigurationError;

configurationError.code satisfies FevexConfigurationErrorCode;

if (configurationError.code === 'INVALID_TOOL') {
  configurationError.code satisfies 'INVALID_TOOL';
}

new FevexConfigurationError('INVALID_CONFIG', 'Invalid configuration');

PROVIDER_SCHEMA_UNSUPPORTED satisfies 'PROVIDER_SCHEMA_UNSUPPORTED';
PROVIDER_REASONING_UNSUPPORTED satisfies 'PROVIDER_REASONING_UNSUPPORTED';

declare const providerResult: ModelResult;

const continuationInput: ModelInput = {
  messages: [{ role: 'user', content: 'Continue.' }],
  providerState: providerResult.providerState,
};

continuationInput.providerState satisfies unknown;

const app = createFevex({
  models: {
    default: {
      async *stream() {
        yield { type: 'output.delta' as const, delta: 'done' };
        yield { type: 'completed' as const, result: { output: 'done' } };
      },
    },
  },
  contextProviders: [
    defineSkill({ name: 'skill', instructions: 'Use this skill.' }),
    defineContextProvider({
      name: 'context',
      async read(context) {
        context.agentName satisfies string;
        return [{ id: 'block', content: context.input }];
      },
    }),
    createMemoryContextProvider({ store: new InMemoryMemoryStore() }),
  ],
  agents: [{
    name: 'assistant',
    instructions: 'Answer.',
    context: ['context'],
    skills: ['skill'],
    memory: { read: true, write: true, limit: 3 },
  }],
  runStore: new InMemoryRunStore(),
});

declare const run: AgentRun<string>;
declare const session: Session;

run.sessionId satisfies string;
session.history satisfies Array<{ role: string; content: string }>;

app.startAgent<string, string>('assistant', { input: 'hello' }) satisfies Promise<AgentRun<string>>;
app.getRun<string>(run.id) satisfies Promise<RunRecord<string> | undefined>;
app.listEvents(run.id, { after: event.id }) satisfies Promise<AgentEvent[]>;
app.cancelRun(run.id) satisfies Promise<boolean>;
app.compactSession(session.id, 'Summary') satisfies Promise<Session>;

declare const channel: ChannelAdapter<Request, Response>;
declare const channelMessage: ChannelMessage;
channel.parse(new Request('https://example.com'), {}) satisfies Promise<ChannelMessage | null>;
channelMessage.conversationId satisfies string;
handleChannelInput(new Request('https://example.com'), {
  fevex: app,
  adapter: channel,
  agentName: 'assistant',
}) satisfies Promise<ChannelRunResult<Response>>;
new ChannelError('CHANNEL_DELIVERY_FAILED', 'Delivery failed') satisfies ChannelError;

createFevexHttpHandler({ fevex: app }) satisfies (
  request: Request,
  context?: { context?: import('./core').ExecutionContext },
) => Promise<Response>;
createFevexHttpClient({ baseUrl: 'https://example.com' }).getRun(run.id) satisfies Promise<RunRecord>;
FEVEX_HTTP_PROTOCOL_VERSION satisfies '1';

declare const knowledgeContext: KnowledgeContext;
declare const contextBlock: ContextBlock;
declare const memoryRecord: MemoryRecord;
knowledgeContext.sessionId satisfies string;
contextBlock.content satisfies string;
memoryRecord.createdAt satisfies string;
