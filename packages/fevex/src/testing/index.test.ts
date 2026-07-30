import { describe, expect, test } from 'bun:test';
import {
  ChannelError,
  compileFevexJsonSchema,
  createFevex,
  defineAgent,
  defineConnection,
  defineContextProvider,
  defineSkill,
  defineTool,
  handleChannelInput,
  InMemoryMemoryStore,
  IntegrationError,
  RunPausedError,
  type AgentEvent,
  validateFevexJsonSchemaProfile,
} from '../index';
import type { ModelGateway, ModelInput, ModelResult, ModelStreamEvent } from '../models';
import { InMemoryRunStore } from '../runtime';
import {
  fakeModel,
  testChannelAdapter,
  testModelGateway,
  testMemoryStore,
  testRunStore,
  testToolProvider,
} from './index';

const input = (content: string, signal?: AbortSignal): ModelInput => ({
  messages: [{ role: 'user', content }],
  signal,
});

function* toModelEvents(result: ModelResult): Generator<ModelStreamEvent> {
  if (result.output !== undefined) {
    const delta = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    if (delta) yield { type: 'output.delta', delta };
  }
  yield { type: 'completed', result };
}

function streamFrom(
  generate: (input: ModelInput) => ModelResult | Promise<ModelResult>,
): ModelGateway['stream'] {
  return async function* (input) {
    yield* toModelEvents(await generate(input));
  };
}

async function collectModel(model: ModelGateway, modelInput: ModelInput): Promise<ModelResult> {
  let result: ModelResult | undefined;
  for await (const event of model.stream(modelInput)) {
    if (event.type === 'completed') result = event.result;
  }
  if (!result) throw new Error('Model stream did not complete');
  return result;
}

function channelMessage(content = 'hello') {
  return {
    id: `message-${content}`,
    deliveryId: `delivery-${content}`,
    conversationId: 'conversation-1',
    content,
  };
}

function channelAdapter() {
  return {
    name: 'memory',
    async parse(input: { text?: string }) {
      return channelMessage(input.text);
    },
    async deliver(output: unknown) {
      return output;
    },
  };
}

describe('RunStore contract', () => {
  test('passes for InMemoryRunStore', async () => {
    await expect(testRunStore(new InMemoryRunStore())).resolves.toBeUndefined();
  });
});

describe('MemoryStore contract', () => {
  test('passes for InMemoryMemoryStore', async () => {
    await expect(testMemoryStore(new InMemoryMemoryStore())).resolves.toBeUndefined();
  });
});

describe('ChannelAdapter contract', () => {
  test('passes parse, ignore and delivery without a server', async () => {
    const message = {
      id: 'message-1',
      deliveryId: 'delivery-1',
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      content: 'hello',
      actor: { id: 'actor-1' },
      metadata: { source: 'test' },
    };
    const output = {
      deliveryId: 'delivery-2',
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      content: 'hi',
      metadata: { ok: true },
    };
    const adapter = {
      name: 'test',
      async parse(input: { ignored?: boolean }) {
        return input.ignored ? null : message;
      },
      async deliver() {
        return { ok: true };
      },
    };

    await expect(testChannelAdapter(adapter, {
      input: {},
      ignoredInput: { ignored: true },
      message,
      output,
      delivered: { ok: true },
    })).resolves.toBeUndefined();
  });

  test('rejects parse and delivery contract violations', async () => {
    const message = {
      id: 'message-1',
      deliveryId: 'delivery-1',
      conversationId: 'conversation-1',
      content: 'hello',
    };
    const output = {
      deliveryId: 'delivery-2',
      conversationId: 'conversation-1',
      content: 'hi',
    };
    const contract = {
      input: {},
      message,
      output,
      delivered: { ok: true },
    };

    await expect(testChannelAdapter({
      name: 'bad-parse',
      async parse() {
        return { ...message, id: '' };
      },
      async deliver() {
        return { ok: true };
      },
    }, contract)).rejects.toThrow('ChannelMessage id cannot be empty');

    await expect(testChannelAdapter({
      name: 'bad-delivery',
      async parse() {
        return message;
      },
      async deliver() {
        return { ok: false };
      },
    }, contract)).rejects.toThrow('unexpected delivery');
  });
});

describe('Channels core', () => {
  test('parses, runs, delivers and returns channel plus run events', async () => {
    const model = fakeModel({ output: { answer: 'hi' } });
    const app = createFevex({
      models: { test: model },
      agents: [defineAgent({
        name: 'assistant',
        instructions: 'Help.',
        model: 'test',
      })],
    });
    const observed: string[] = [];
    const delivered: unknown[] = [];
    const adapter = {
      name: 'memory',
      async parse(input: { id: string; text: string }) {
        return {
          id: input.id,
          deliveryId: `delivery-${input.id}`,
          conversationId: 'conversation-1',
          threadId: 'thread-1',
          content: input.text,
          actor: { id: 'actor-1' },
          metadata: { source: 'memory' },
        };
      },
      async deliver(output: unknown) {
        delivered.push(output);
        return { ok: true };
      },
    };

    const result = await handleChannelInput({ id: 'message-1', text: 'hello' }, {
      fevex: app,
      adapter,
      agentName: 'assistant',
      onEvent(event) {
        observed.push(event.type);
      },
    });

    expect(result.ignored).toBe(false);
    if (result.ignored) throw new Error('Expected handled message');
    expect(result.output).toMatchObject({
      deliveryId: 'delivery-message-1',
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      content: '{"answer":"hi"}',
      metadata: { runId: result.run.id, sessionId: result.run.sessionId },
    });
    expect(result.delivery).toEqual({ ok: true });
    expect(result.events.map((event) => event.type)).toEqual([
      'channel.received',
      'run.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
      'channel.delivered',
    ]);
    expect(observed).toEqual(['channel.received', 'channel.delivered']);
    expect(delivered).toEqual([result.output]);
    expect(model.calls[0]?.messages.find((message) => message.role === 'user')?.content).toBe(
      'hello',
    );
  });

  test('ignores null parse without starting a run', async () => {
    const model = fakeModel({ output: 'unused' });
    const app = createFevex({
      models: { test: model },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.', model: 'test' })],
    });
    const result = await handleChannelInput({}, {
      fevex: app,
      agentName: 'assistant',
      adapter: {
        name: 'memory',
        async parse() {
          return null;
        },
        async deliver() {
          throw new Error('unused');
        },
      },
    });

    expect(result).toEqual({ ignored: true, events: [] });
    expect(model.calls).toHaveLength(0);
  });

  test('emits safe failed events for parse, run and deliver errors', async () => {
    const app = createFevex({
      models: { test: fakeModel({ output: 'ok' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.', model: 'test' })],
    });
    const parseEvents: string[] = [];
    await expect(handleChannelInput({}, {
      fevex: app,
      agentName: 'assistant',
      adapter: {
        name: 'memory',
        async parse() {
          throw new Error('secret parse');
        },
        async deliver() {
          return null;
        },
      },
      onEvent(event) {
        parseEvents.push(`${event.type}:${event.type === 'channel.failed' ? event.phase : ''}`);
      },
    })).rejects.toBeInstanceOf(ChannelError);
    expect(parseEvents).toEqual(['channel.failed:parse']);

    const runEvents: string[] = [];
    await expect(handleChannelInput({ text: 'hello' }, {
      fevex: app,
      agentName: 'missing',
      adapter: channelAdapter(),
      onEvent(event) {
        runEvents.push(`${event.type}:${event.type === 'channel.failed' ? event.phase : ''}`);
      },
    })).rejects.toMatchObject({ code: 'CHANNEL_RUN_FAILED' });
    expect(runEvents).toEqual(['channel.received:', 'channel.failed:run']);

    const deliverEvents: string[] = [];
    await expect(handleChannelInput({ text: 'hello' }, {
      fevex: app,
      agentName: 'assistant',
      adapter: {
        ...channelAdapter(),
        async deliver() {
          throw new Error('secret deliver');
        },
      },
      onEvent(event) {
        deliverEvents.push(`${event.type}:${event.type === 'channel.failed' ? event.phase : ''}`);
      },
    })).rejects.toMatchObject({ code: 'CHANNEL_DELIVERY_FAILED' });
    expect(deliverEvents).toEqual(['channel.received:', 'channel.failed:deliver']);
  });

  test('resolveSessionId continues a conversation and AbortSignal reaches adapter and run', async () => {
    const controller = new AbortController();
    const seenSignals: boolean[] = [];
    const sessions = new Map<string, string>();
    const app = createFevex({
      models: {
        test: fakeModel({ output: 'first' }, { output: 'second' }),
      },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.', model: 'test' })],
    });
    const adapter = {
      ...channelAdapter(),
      async parse(input: { text: string }, context: { signal?: AbortSignal }) {
        seenSignals.push(context.signal === controller.signal);
        return channelMessage(input.text);
      },
      async deliver(output: unknown, context: { signal?: AbortSignal }) {
        seenSignals.push(context.signal === controller.signal);
        return output;
      },
    };
    const first = await handleChannelInput({ text: 'one' }, {
      fevex: app,
      adapter,
      agentName: 'assistant',
      signal: controller.signal,
      resolveSessionId(message) {
        return sessions.get(message.conversationId);
      },
    });
    if (first.ignored) throw new Error('Expected first run');
    sessions.set(first.message.conversationId, first.run.sessionId);

    const second = await handleChannelInput({ text: 'two' }, {
      fevex: app,
      adapter,
      agentName: 'assistant',
      signal: controller.signal,
      resolveSessionId(message) {
        return sessions.get(message.conversationId);
      },
    });

    if (second.ignored) throw new Error('Expected second run');
    expect(second.run.sessionId).toBe(first.run.sessionId);
    expect(seenSignals).toEqual([true, true, true, true]);
  });
});

describe('Knowledge and memory', () => {
  test('injects skills, session history, context and memory before input', async () => {
    const calls: ModelInput[] = [];
    const memoryStore = new InMemoryMemoryStore();
    const app = createFevex({
      models: {
        test: {
          stream: streamFrom((input) => {
            calls.push(input);
            return { output: calls.length === 1 ? 'first' : 'second' };
          }),
        },
      },
      contextProviders: [
        defineSkill({
          name: 'billing',
          instructions: 'Use billing policy.',
          resources: [{ id: 'limits', content: { refundDays: 30 } }],
        }),
        defineContextProvider({
          name: 'account',
          async read() {
            return [{ id: 'status', content: 'Account tier is enterprise.' }];
          },
        }),
      ],
      memoryStore,
      agents: [
        defineAgent({
          name: 'assistant',
          instructions: 'Answer clearly.',
          model: 'test',
          skills: ['billing'],
          context: ['account'],
          memory: { read: true, limit: 1 },
        }),
      ],
    });
    await memoryStore.write(
      { content: 'Previous refund was approved.', agentName: 'assistant' },
      { agentName: 'assistant', input: 'refund', sessionId: 'seed' },
    );

    const first = await app.runAgent('assistant', { input: 'hello refund' });
    await app.runAgent('assistant', { input: 'next refund', sessionId: first.sessionId });

    const secondMessages = calls[1]!.messages.map((message) => message.content);
    expect(secondMessages.slice(0, 6)).toEqual([
      'Answer clearly.',
      '[Skill: billing/billing:instructions]\nUse billing policy.',
      '[Skill: billing/limits]\n{"refundDays":30}',
      'hello refund',
      'first',
      '[Context: account/status]\nAccount tier is enterprise.',
    ]);
    expect(secondMessages[6]).toMatch(/\[Memory: .+\]\nPrevious refund was approved\./);
    expect(secondMessages[7]).toBe('next refund');
  });

  test('runs providers lazily and propagates AbortSignal', async () => {
    const controller = new AbortController();
    let used = 0;
    let unused = 0;
    let providerSawSignal = false;
    let memorySawSearchSignal = false;
    let memorySawWriteSignal = false;
    const memoryStore = {
      async search(_query: unknown, context: { signal?: AbortSignal }) {
        memorySawSearchSignal = context.signal instanceof AbortSignal;
        return [{ id: 'm1', content: 'remember this', createdAt: new Date().toISOString() }];
      },
      async write(_record: unknown, context: { signal?: AbortSignal }) {
        memorySawWriteSignal = context.signal instanceof AbortSignal;
        return { id: 'm2', content: 'saved', createdAt: new Date().toISOString() };
      },
    };
    const app = createFevex({
      models: { test: fakeModel({ output: 'ok' }) },
      contextProviders: [
        defineContextProvider({
          name: 'used',
          async read(context) {
            used += 1;
            providerSawSignal = context.signal instanceof AbortSignal;
            return [{ id: 'c1', content: 'context' }];
          },
        }),
        defineContextProvider({
          name: 'unused',
          async read() {
            unused += 1;
            return [];
          },
        }),
      ],
      memoryStore,
      agents: [
        defineAgent({
          name: 'assistant',
          instructions: 'Help.',
          model: 'test',
          context: ['used'],
          memory: { read: true, write: true },
        }),
      ],
    });

    await app.runAgent('assistant', { input: 'hello', signal: controller.signal });

    expect(used).toBe(1);
    expect(unused).toBe(0);
    expect(providerSawSignal).toBe(true);
    expect(memorySawSearchSignal).toBe(true);
    expect(memorySawWriteSignal).toBe(true);
  });

  test('validates provider references and reports provider failures safely', async () => {
    expect(() =>
      createFevex({
        models: { test: fakeModel({ output: 'ok' }) },
        contextProviders: [],
        agents: [defineAgent({ name: 'assistant', instructions: 'Help.', model: 'test', context: ['missing'] })],
      }),
    ).toThrow('Context provider "missing" required by agent "assistant" is not registered');
    expect(() =>
      createFevex({
        models: { test: fakeModel({ output: 'ok' }) },
        contextProviders: [defineSkill({ name: 'skill', instructions: 'Use it.' })],
        agents: [defineAgent({ name: 'assistant', instructions: 'Help.', model: 'test', skills: ['skill', 'skill'] })],
      }),
    ).toThrow('Skill "skill" is duplicated in agent "assistant"');

    const app = createFevex({
      models: { test: fakeModel({ output: 'ok' }) },
      contextProviders: [
        defineContextProvider({
          name: 'bad',
          async read() {
            throw new Error('secret token');
          },
        }),
      ],
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.', model: 'test', context: ['bad'] })],
    });

    try {
      await app.runAgent('assistant', { input: 'hello' });
      throw new Error('Expected provider failure');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Context provider "bad" failed');
      expect((error as Error).message).not.toContain('secret token');
    }
  });

  test('writes memory only for completed runs', async () => {
    let writes = 0;
    const memoryStore = {
      async search() {
        return [];
      },
      async write() {
        writes += 1;
        return { id: `memory-${writes}`, content: 'saved', createdAt: new Date().toISOString() };
      },
    };
    const approvalTool = defineTool({
      name: 'approval_tool',
      approval: 'required',
      async execute() {
        return 'done';
      },
    });
    const app = createFevex({
      models: {
        ok: fakeModel({ output: 'ok' }),
        fail: {
          async *stream() {
            throw new Error('model failed');
          },
        },
        pause: fakeModel({ toolCalls: [{ id: 'tool-1', name: 'approval_tool', input: {} }] }),
      },
      tools: [approvalTool],
      memoryStore,
      agents: [
        defineAgent({ name: 'ok', instructions: 'Help.', model: 'ok', memory: { write: true } }),
        defineAgent({ name: 'fail', instructions: 'Help.', model: 'fail', memory: { write: true } }),
        defineAgent({
          name: 'pause',
          instructions: 'Help.',
          model: 'pause',
          tools: ['approval_tool'],
          memory: { write: true },
        }),
      ],
    });

    await app.runAgent('ok', { input: 'hello' });
    await expect(app.runAgent('fail', { input: 'hello' })).rejects.toThrow('model failed');
    await expect(app.runAgent('pause', { input: 'hello' })).rejects.toBeInstanceOf(RunPausedError);

    expect(writes).toBe(1);
  });
});

describe('ToolProvider contract', () => {
  test('passes tool provider checks', async () => {
    const provider = {
      async listTools() {
        return [{ name: 'lookup', inputSchema: { type: 'object' } }];
      },
      async callTool(name: string) {
        if (name === 'contract_error') {
          throw new IntegrationError(
            'CONNECTION_REMOTE_ERROR',
            'remote',
            false,
            'safe remote failure',
            { cause: new Error('secret-token') },
          );
        }
        return { answer: 'ok' };
      },
    };

    await expect(testToolProvider(provider, {
      allowedTool: 'lookup',
      disallowedTool: 'delete',
      safeError: true,
    })).resolves.toBeUndefined();
  });
});

describe('Fevex JSON Schema Profile V1', () => {
  test('accepts and validates supported keywords and local refs', () => {
    const root = {
      components: {
        schemas: {
          Account: {
            type: 'object',
            properties: {
              id: { type: 'integer', minimum: 1 },
              status: { enum: ['active', 'paused'] },
            },
            required: ['id', 'status'],
            additionalProperties: false,
          },
        },
      },
    };
    const validator = compileFevexJsonSchema({
      allOf: [
        { $ref: '#/components/schemas/Account' },
        { type: 'object', properties: { status: { const: 'active' } } },
      ],
    }, { rootDocument: root, requireRootObject: true });

    expect(validator.validate({ id: 1, status: 'active' })).toEqual({
      id: 1,
      status: 'active',
    });
    expect(() => validator.validate({ id: 0, status: 'paused' })).toThrow();
  });

  test('supports arrays and anyOf/oneOf', () => {
    const validator = compileFevexJsonSchema({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 1 },
        mode: { oneOf: [{ const: 'a' }, { const: 'b' }] },
        value: { anyOf: [{ type: 'string' }, { type: 'number', maximum: 10 }] },
      },
      required: ['tags', 'mode', 'value'],
    }, { requireRootObject: true });

    expect(validator.validate({ tags: ['ok'], mode: 'a', value: 10 })).toEqual({
      tags: ['ok'],
      mode: 'a',
      value: 10,
    });
    expect(() => validator.validate({ tags: ['x'], mode: 'c', value: 11 })).toThrow();
  });

  test('rejects unsupported keywords, remote refs, cycles and limits', () => {
    expect(() => validateFevexJsonSchemaProfile({
      type: 'object',
      pattern: '^x',
    })).toThrow('pattern');
    expect(() => validateFevexJsonSchemaProfile({
      $ref: 'https://example.com/schema.json',
    })).toThrow('Remote');
    expect(() => validateFevexJsonSchemaProfile({
      $defs: { node: { $ref: '#/$defs/node' } },
      $ref: '#/$defs/node',
    })).toThrow('cycle');
    expect(() => validateFevexJsonSchemaProfile({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    }, { limits: { maxProperties: 1 } })).toThrow('maxProperties');
    expect(() => validateFevexJsonSchemaProfile({
      type: 'string',
    }, { requireRootObject: true })).toThrow('root must be object');
  });
});

describe('Connections', () => {
  test('runs a namespaced remote tool through the normal runtime', async () => {
    const calls: unknown[] = [];
    const events: AgentEvent[] = [];
    const model = fakeModel(
      { toolCalls: [{ id: 'call-1', name: 'remote__lookup', input: { query: 'value' } }] },
      { output: 'done' },
    );
    const app = createFevex({
      models: {
        test: model,
      },
      agents: [defineAgent({
        name: 'assistant',
        instructions: 'Help.',
        model: 'test',
        tools: ['remote__lookup'],
      })],
      connections: [
        defineConnection({
          name: 'remote',
          allowlist: ['lookup'],
          provider: {
            kind: 'mcp',
            async listTools() {
              return [{
                name: 'lookup',
                description: 'Lookup.',
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
              }];
            },
            async callTool(_name, input) {
              calls.push(input);
              return { found: true };
            },
          },
        }),
      ],
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(app.runAgent('assistant', { input: 'hello' })).resolves.toMatchObject({
      output: 'done',
    });
    expect(calls).toEqual([{ query: 'value' }]);
    expect(model.calls[0]?.tools?.[0]).toEqual({
      name: 'remote__lookup',
      description: 'Lookup.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    });
    expect(events.map(({ type }) => type)).toContain('tool.started');
    expect(events.find(({ type }) => type === 'tool.started')?.payload).toMatchObject({
      toolName: 'remote__lookup',
      source: {
        kind: 'connection',
        provider: 'mcp',
        connectionName: 'remote',
        remoteToolName: 'lookup',
      },
    });
    expect(events.find(({ type }) => type === 'tool.completed')?.payload).toMatchObject({
      toolName: 'remote__lookup',
      source: {
        kind: 'connection',
        provider: 'mcp',
        connectionName: 'remote',
        remoteToolName: 'lookup',
      },
    });
  });

  test('rejects connection tool collisions', () => {
    expect(() =>
      createFevex({
        models: { test: fakeModel({ output: 'ok' }) },
        agents: [defineAgent({
          name: 'assistant',
          instructions: 'Help.',
          model: 'test',
          tools: ['remote__lookup'],
        })],
        tools: [{
          name: 'remote__lookup',
          execute: () => 'local',
        }],
        connections: [
          defineConnection({
            name: 'remote',
            allowlist: ['lookup'],
            provider: {
              async listTools() {
                return [{ name: 'lookup' }];
              },
              async callTool() {
                return null;
              },
            },
          }),
        ],
      }),
    ).toThrow('duplicated');
  });

  test('aborts remote tools with a safe timeout error', async () => {
    const failed: AgentEvent<'tool.failed'>[] = [];
    const app = createFevex({
      models: {
        test: fakeModel({
          toolCalls: [{ id: 'call-1', name: 'remote__slow', input: { secret: 'token' } }],
        }),
      },
      agents: [defineAgent({
        name: 'assistant',
        instructions: 'Help.',
        model: 'test',
        tools: ['remote__slow'],
      })],
      connections: [
        defineConnection({
          name: 'remote',
          allowlist: ['slow'],
          timeoutMs: 1,
          provider: {
            async listTools() {
              return [{ name: 'slow' }];
            },
            async callTool(_name, _input, context) {
              await new Promise((_resolve, reject) => {
                context.signal?.addEventListener('abort', () => reject(context.signal!.reason));
              });
              return null;
            },
          },
        }),
      ],
      onEvent(event) {
        if (event.type === 'tool.failed') failed.push(event);
      },
    });

    await expect(app.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      'Connection tool call timed out',
    );
    expect(failed.map(({ payload }) => payload.error)).toEqual(['Connection tool call timed out']);
    expect(failed[0]?.payload).toMatchObject({
      errorCode: 'CONNECTION_TIMEOUT',
      retryable: true,
      source: {
        kind: 'connection',
        provider: 'custom',
        connectionName: 'remote',
        remoteToolName: 'slow',
      },
    });
  });

  test('tags connection list failures before a tool starts', async () => {
    const events: AgentEvent[] = [];
    const app = createFevex({
      models: { test: fakeModel({ output: 'unused' }) },
      agents: [defineAgent({
        name: 'assistant',
        instructions: 'Help.',
        model: 'test',
        tools: ['remote__lookup'],
      })],
      connections: [
        defineConnection({
          name: 'remote',
          allowlist: ['lookup'],
          provider: {
            kind: 'mcp',
            async listTools() {
              throw new IntegrationError(
                'MCP_AUTH_REQUIRED',
                'auth',
                false,
                'MCP server requires authentication',
              );
            },
            async callTool() {
              return null;
            },
          },
        }),
      ],
    });

    await expect((async () => {
      for await (const event of app.streamAgent('assistant', { input: 'hello' })) {
        events.push(event);
      }
    })()).rejects.toThrow('MCP server requires authentication');
    expect(events.find(({ type }) => type === 'run.failed')?.payload).toMatchObject({
      error: 'MCP server requires authentication',
      errorCode: 'MCP_AUTH_REQUIRED',
      retryable: false,
      source: {
        kind: 'connection',
        provider: 'mcp',
        connectionName: 'remote',
        remoteToolName: 'lookup',
      },
    });
  });
});

describe('fakeModel', () => {
  test('returns responses in order and records calls', async () => {
    const first = { output: 'first' };
    const second = { output: 'second' };
    const model = fakeModel(first, second);
    const firstInput = input('one');
    const secondInput = input('two');

    await expect(collectModel(model, firstInput)).resolves.toBe(first);
    await expect(collectModel(model, secondInput)).resolves.toBe(second);
    expect(model.calls).toEqual([firstInput, secondInput]);
  });

  test('does not consume or record an aborted call', async () => {
    const model = fakeModel({ output: 'ok' });
    const controller = new AbortController();
    controller.abort();

    await expect(collectModel(model, input('aborted', controller.signal))).rejects.toThrow();
    expect(model.calls).toHaveLength(0);
    await expect(collectModel(model, input('next'))).resolves.toEqual({ output: 'ok' });
  });

  test('fails when responses are exhausted', async () => {
    const model = fakeModel();

    await expect(collectModel(model, input('one'))).rejects.toThrow(
      'fakeModel has no response for call 1',
    );
    expect(model.calls).toHaveLength(1);
  });

  test('passes the shared ModelGateway contract', async () => {
    const model = fakeModel(
      { output: { answer: 'ok' }, usage: { totalTokens: 1 } },
      { toolCalls: [{ id: 'call-1', name: 'lookup', input: { query: 'value' } }] },
    );

    await expect(testModelGateway(model, { usage: true })).resolves.toBeUndefined();
  });

  test('ModelGateway contract preserves provider error identity', async () => {
    const providerError = new Error('provider failed');
    let calls = 0;

    await expect(
      testModelGateway(
        {
          stream: streamFrom(async (input) => {
            input.signal?.throwIfAborted();
            calls += 1;
            if (calls === 1) return { output: { answer: 'ok' } };
            if (calls === 2) {
              return { toolCalls: [{ id: 'call-1', name: 'lookup', input: { query: 'value' } }] };
            }
            throw providerError;
          }),
        },
        { error: providerError },
      ),
    ).resolves.toBeUndefined();
  });

  test('ModelGateway contract detects invalid gateways', async () => {
    await expect(
      testModelGateway({
        stream: streamFrom(async () => {
          return {};
        }),
      }),
    ).rejects.toThrow('ModelGateway must stream an output delta before completed');

    await expect(
      testModelGateway(fakeModel({ output: { answer: 'ok' } }, { output: 'not a tool call' })),
    ).rejects.toThrow('ModelGateway must return one tool call');
  });
});
