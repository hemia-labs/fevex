import { describe, expect, test } from 'bun:test';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { AgentDefinition } from './agents';
import {
  PROVIDER_REASONING_UNSUPPORTED,
  PROVIDER_SCHEMA_UNSUPPORTED,
  SCHEMA_NOT_TRANSPORTABLE,
  type AgentEvent,
  type JsonObject,
  type ToolCall,
} from './core';
import type { ModelGateway, ModelInput, ModelResult, ModelStreamEvent } from './models';
import type { ToolExecutionContext } from './tools';
import {
  createFevex,
  defineAgent,
  defineTool,
  defineTeam,
  defineWorkflow,
  FevexConfigurationError,
  FevexRunError,
  InMemoryRunStore,
  RunPausedError,
  SandboxError,
  type FevexConfig,
  type FevexConfigurationErrorCode,
  type RunCheckpoint,
  type StoredRunCheckpoint,
  type WorkflowDefinition,
} from './index';

type TestSchema<TOutput> = StandardSchemaV1<unknown, TOutput> &
  StandardJSONSchemaV1<unknown, TOutput>;

const schemaOnly = <TOutput>(
  validate: StandardSchemaV1<unknown, TOutput>['~standard']['validate'],
): StandardSchemaV1<unknown, TOutput> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate,
  },
});

const schema = <TOutput>(
  validate: StandardSchemaV1<unknown, TOutput>['~standard']['validate'],
  jsonSchema: JsonObject = { type: 'object' },
): TestSchema<TOutput> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate,
    jsonSchema: {
      input: () => jsonSchema,
      output: () => jsonSchema,
    },
  },
});

const passthroughSchema = <TOutput>(jsonSchema?: JsonObject): TestSchema<TOutput> =>
  schema((value) => ({ value: value as TOutput }), jsonSchema);

const agent = (name: string, overrides: Partial<AgentDefinition> = {}) =>
  defineAgent({
    name,
    instructions: 'Answer clearly.',
    ...overrides,
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

const modelWithOutput = (output: unknown): ModelGateway => ({
  stream: streamFrom(async () => {
    return { output };
  }),
});

const lookupCall: ToolCall = {
  id: 'call-1',
  name: 'lookup',
  input: { query: 'value' },
};

function getConfigurationError(config: unknown): FevexConfigurationError {
  try {
    createFevex(config as FevexConfig);
  } catch (error) {
    expect(error).toBeInstanceOf(FevexConfigurationError);
    return error as FevexConfigurationError;
  }

  throw new Error('Expected createFevex to reject the configuration');
}

describe('createFevex', () => {
  test('exports distinct schema boundary error codes', () => {
    expect(SCHEMA_NOT_TRANSPORTABLE).toBe('SCHEMA_NOT_TRANSPORTABLE');
    expect(PROVIDER_SCHEMA_UNSUPPORTED).toBe('PROVIDER_SCHEMA_UNSUPPORTED');
    expect(PROVIDER_REASONING_UNSUPPORTED).toBe('PROVIDER_REASONING_UNSUPPORTED');
  });

  test('runs the default model and forwards agent options', async () => {
    const calls: ModelInput[] = [];
    const requestSchemaJson = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const requestSchema = passthroughSchema<{ answer: string }>(requestSchemaJson);
    const toolInputSchemaJson = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    };
    const toolInputSchema = passthroughSchema<{ query: string }>(toolInputSchemaJson);
    const signal = new AbortController().signal;
    const model: ModelGateway = {
      stateCodec: {
        serialize: (state) => structuredClone(state) as JsonObject,
        restore: (state) => structuredClone(state),
      },
      stream: streamFrom(async (input) => {
        calls.push(input);
        return {
          output: { answer: 'done' },
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      }),
    };
    const lookup = defineTool({
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: toolInputSchema,
      execute() {
        return 'found';
      },
    });
    const app = createFevex({
      models: { default: model },
      agents: [
        agent('assistant', {
          tools: ['lookup'],
          reasoning: 'low',
          modelOptions: { temperature: 0 },
          outputSchema: requestSchema,
        }),
      ],
      tools: [lookup],
    });

    const result = await app.runAgent<{ question: string }, { answer: string }>('assistant', {
      input: { question: 'Ready?' },
      signal,
    });

    expect(result.output).toEqual({ answer: 'done' });
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    expect(calls[0]).toEqual({
      messages: [
        { role: 'system', content: 'Answer clearly.' },
        { role: 'user', content: '{"question":"Ready?"}' },
      ],
      tools: [
        { name: 'lookup', description: 'Look up a value.', inputSchema: toolInputSchemaJson },
      ],
      reasoning: 'low',
      modelOptions: { temperature: 0 },
      outputSchema: requestSchemaJson,
      signal,
    });
    expect(result.events?.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ]);
    expect(result.events?.[3]?.payload).toEqual({
      step: 1,
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
    expect(result.events?.[4]?.payload).toEqual({
      output: { answer: 'done' },
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
    expect(result.events?.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(result.events?.map(({ id }) => id)).size).toBe(5);
    expect(new Set(result.events?.map(({ runId }) => runId)).size).toBe(1);
    for (const event of result.events ?? []) {
      expect(event.runId).not.toBe('');
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    }

    await app.runAgent('assistant', { input: 'hello' });
    expect(calls[1]?.messages[1]?.content).toBe('hello');
    expect(calls[1]?.outputSchema).toEqual(requestSchemaJson);
  });

  test('executes one tool and sends its result back to the model', async () => {
    const calls: ModelInput[] = [];
    const signal = new AbortController().signal;
    const context = { namespace: 'test' };
    const outputSchemaJson = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const outputSchema = passthroughSchema<{ answer: string }>(outputSchemaJson);
    const providerState = { private: 'state' };
    let execution: { input: unknown; context: ToolExecutionContext } | undefined;
    const model: ModelGateway = {
      stateCodec: {
        serialize: (state) => structuredClone(state) as JsonObject,
        restore: (state) => structuredClone(state),
      },
      stream: streamFrom(async (input) => {
        calls.push(input);
        if (calls.length === 1) {
          return {
            output: 'Looking up the value.',
            toolCalls: [lookupCall],
            providerState,
            usage: { inputTokens: 3, totalTokens: 3 },
          };
        }
        return {
          output: { answer: 'found' },
          usage: { outputTokens: 2, totalTokens: 2 },
        };
      }),
    };
    const lookup = defineTool({
      name: 'lookup',
      description: 'Look up a value.',
      execute(input, toolContext) {
        execution = { input, context: toolContext };
        return { found: true };
      },
    });
    const app = createFevex({
      models: { default: model },
      agents: [
        agent('assistant', {
          tools: ['lookup'],
          reasoning: 'low',
          modelOptions: { temperature: 0 },
          outputSchema,
        }),
      ],
      tools: [lookup],
    });

    const result = await app.runAgent<unknown, { answer: string }>('assistant', {
      input: 'Find it.',
      context,
      signal,
    });
    const runId = result.events![0]!.runId;

    expect(result.output).toEqual({ answer: 'found' });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(execution).toEqual({
      input: { query: 'value' },
      context: expect.objectContaining({
        runId,
        toolCallId: 'call-1',
        attempt: 1,
        context,
        signal,
      }),
    });
    expect(calls[0]?.messages).toEqual([
      { role: 'system', content: 'Answer clearly.' },
      { role: 'user', content: 'Find it.' },
    ]);
    expect(calls[1]).toEqual({
      messages: [
        { role: 'system', content: 'Answer clearly.' },
        { role: 'user', content: 'Find it.' },
        {
          role: 'assistant',
          content: 'Looking up the value.',
          toolCalls: [lookupCall],
        },
        {
          role: 'tool',
          name: 'lookup',
          toolCallId: 'call-1',
          content: '{"found":true}',
        },
      ],
      tools: [{ name: 'lookup', description: 'Look up a value.' }],
      reasoning: 'low',
      modelOptions: { temperature: 0 },
      outputSchema: outputSchemaJson,
      providerState,
      signal,
    });
    expect(result.events?.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'tool.started',
      'tool.completed',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ]);
    expect(result.events?.[5]?.payload).toEqual({
      step: 1,
      toolCallId: 'call-1',
      toolName: 'lookup',
    });
    expect(new Set(result.events?.map((event) => event.runId))).toEqual(new Set([runId]));
  });

  test('passes a scoped sandbox only to tools that declare sandbox capabilities', async () => {
    const sandboxRequests: unknown[] = [];
    const sandbox = {
      async run(request: unknown) {
        sandboxRequests.push(request);
        return { exitCode: 0, stdout: 'sandboxed', stderr: '', durationMs: 1, timedOut: false };
      },
    };
    const model: ModelGateway = {
      stream: streamFrom(async (input) => {
        const toolMessages = input.messages.filter(({ role }) => role === 'tool');
        if (!toolMessages.length) {
          return {
            toolCalls: [
              { id: 'sandbox-call', name: 'code', input: {} },
              { id: 'plain-call', name: 'plain', input: {} },
            ],
          };
        }
        return { output: toolMessages.map(({ content }) => content).join('/') };
      }),
    };
    const app = createFevex({
      models: { default: model },
      agents: [agent('assistant', { tools: ['code', 'plain'] })],
      sandbox,
      tools: [
        defineTool({
          name: 'code',
          sandbox: { process: { commands: ['node'] }, resources: { timeoutMs: 1000 } },
          async execute(_input, context) {
            expect(context.sandbox).toBeDefined();
            const result = await context.sandbox!.run({ command: 'node', args: ['-e', ''] });
            return result.stdout;
          },
        }),
        defineTool({
          name: 'plain',
          execute(_input, context) {
            expect(context.sandbox).toBeUndefined();
            return 'plain';
          },
        }),
      ],
    });

    await expect(app.runAgent('assistant', { input: 'run' })).resolves.toMatchObject({
      output: 'sandboxed/plain',
    });
    expect(sandboxRequests).toEqual([
      expect.objectContaining({
        command: 'node',
        toolCallId: 'sandbox-call',
        capabilities: { process: { commands: ['node'] }, resources: { timeoutMs: 1000 } },
      }),
    ]);
  });

  test('reports sandbox failures through normal tool failure events', async () => {
    const events: AgentEvent[] = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => ({
            toolCalls: [{ id: 'sandbox-call', name: 'code', input: {} }],
          })),
        },
      },
      agents: [agent('assistant', { tools: ['code'] })],
      sandbox: {
        async run() {
          throw new SandboxError('SANDBOX_DENIED', 'sandbox denied');
        },
      },
      tools: [
        defineTool({
          name: 'code',
          sandbox: { process: { commands: ['node'] } },
          async execute(_input, context) {
            return await context.sandbox!.run({ command: 'node' });
          },
        }),
      ],
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(app.runAgent('assistant', { input: 'run' })).rejects.toThrow('sandbox denied');
    expect(events.find(({ type }) => type === 'tool.failed')).toMatchObject({
      payload: { toolCallId: 'sandbox-call', toolName: 'code', error: 'sandbox denied' },
    });
  });

  test('keeps providerState isolated between concurrent runs', async () => {
    const continuedStates: unknown[] = [];
    const model: ModelGateway = {
      stateCodec: {
        serialize: (state) => structuredClone(state) as JsonObject,
        restore: (state) => structuredClone(state),
      },
      stream: streamFrom(async (input) => {
        if (input.providerState !== undefined) {
          continuedStates.push(input.providerState);
          return {
            output: (input.providerState as { label: string }).label,
          };
        }

        const label = input.messages[1]!.content;
        return {
          toolCalls: [
            {
              id: `call-${label}`,
              name: 'lookup',
              input: { label },
            },
          ],
          providerState: { label },
        };
      }),
    };
    const app = createFevex({
      models: { default: model },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [defineTool({ name: 'lookup', execute: (value) => value })],
    });

    const [first, second] = await Promise.all([
      app.runAgent('assistant', { input: 'first' }),
      app.runAgent('assistant', { input: 'second' }),
    ]);

    expect([first.output, second.output]).toEqual(['first', 'second']);
    expect(continuedStates).toHaveLength(2);
    expect(new Set(continuedStates).size).toBe(2);
  });

  test('runs multiple model steps and sequential tool batches', async () => {
    const calls: ModelInput[] = [];
    const executions: string[] = [];
    const model: ModelGateway = {
      stream: streamFrom(async (input) => {
        calls.push(input);
        if (calls.length === 1) {
          return {
            toolCalls: [
              { id: 'call-1', name: 'lookup', input: { value: 1 } },
              { id: 'call-2', name: 'format', input: { value: 2 } },
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }
        if (calls.length === 2) {
          return {
            toolCalls: [{ id: 'call-3', name: 'lookup', input: { value: 3 } }],
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          };
        }
        return {
          output: 'done',
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        };
      }),
    };
    const app = createFevex({
      models: { default: model },
      agents: [agent('assistant', { tools: ['lookup', 'format'] })],
      tools: [
        defineTool({
          name: 'lookup',
          execute(input) {
            executions.push(`lookup:${(input as { value: number }).value}`);
            return input;
          },
        }),
        defineTool({
          name: 'format',
          execute(input) {
            executions.push(`format:${(input as { value: number }).value}`);
            return input;
          },
        }),
      ],
    });

    const result = await app.runAgent<unknown, string>('assistant', { input: 'work' });

    expect(result.output).toBe('done');
    expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 3, totalTokens: 9 });
    expect(executions).toEqual(['lookup:1', 'format:2', 'lookup:3']);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.messages.map(({ role }) => role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'tool',
    ]);
    expect(result.events?.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.completed',
      'tool.started',
      'tool.completed',
      'tool.started',
      'tool.completed',
      'model.started',
      'model.completed',
      'tool.started',
      'tool.completed',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ]);
    expect(
      result.events?.filter(({ type }) => type === 'model.completed').map(({ payload }) => payload),
    ).toEqual([
      { step: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      { step: 2, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
      { step: 3, usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 } },
    ]);
  });

  test('serializes tool outputs for the model', async () => {
    const cases: Array<[unknown, string]> = [
      ['text', 'text'],
      [{ value: 1 }, '{"value":1}'],
      [7, '7'],
      [true, 'true'],
      [null, 'null'],
    ];

    for (const [toolOutput, expected] of cases) {
      const calls: ModelInput[] = [];
      const model: ModelGateway = {
        stream: streamFrom(async (input) => {
          calls.push(input);
          return calls.length === 1 ? { toolCalls: [lookupCall] } : { output: 'done' };
        }),
      };
      const app = createFevex({
        models: { default: model },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [defineTool({ name: 'lookup', execute: () => toolOutput })],
      });

      await app.runAgent('assistant', { input: 'hello' });
      expect(calls[1]?.messages[3]?.content).toBe(expected);
    }
  });

  test('serializes JSON primitive inputs', async () => {
    const contents: string[] = [];
    const model: ModelGateway = {
      stream: streamFrom(async (input) => {
        contents.push(input.messages[1]!.content);
        return { output: 'ok' };
      }),
    };
    const app = createFevex({ models: { default: model }, agents: [agent('assistant')] });

    for (const input of [42, true, null]) {
      await app.runAgent('assistant', { input });
    }

    expect(contents).toEqual(['42', 'true', 'null']);
  });

  test('normalizes plain JSON without rejecting repeated references', async () => {
    let content = '';
    const shared = { value: 1 };
    const model: ModelGateway = {
      stream: streamFrom(async (input) => {
        content = input.messages[1]!.content;
        return { output: { optional: undefined, result: 'ok' } };
      }),
    };
    const app = createFevex({ models: { default: model }, agents: [agent('assistant')] });

    const result = await app.runAgent('assistant', {
      input: { optional: undefined, first: shared, second: shared },
    });

    expect(content).toBe('{"first":{"value":1},"second":{"value":1}}');
    expect(result.output).toEqual({ result: 'ok' });
  });

  test('preserves special JSON keys across every runtime boundary', async () => {
    const specialJson =
      '{"__proto__":{"polluted":true},"constructor":{"safe":true},' +
      '"prototype":"value","nested":{"__proto__":"nested"},' +
      '"items":[{"__proto__":"array"}]}';
    const specialValue = () => JSON.parse(specialJson) as JsonObject;
    const calls: ModelInput[] = [];
    let toolInput: unknown;
    const boundarySchema = schema<JsonObject>(() => ({ value: specialValue() }), specialValue());
    const model: ModelGateway = {
      stream: streamFrom(async (input) => {
        calls.push(input);
        return calls.length === 1
          ? { toolCalls: [{ ...lookupCall, input: specialValue() }] }
          : { output: specialValue() };
      }),
    };
    const app = createFevex({
      models: { default: model },
      agents: [
        agent('assistant', {
          tools: ['lookup'],
          outputSchema: boundarySchema,
        }),
      ],
      tools: [
        defineTool({
          name: 'lookup',
          inputSchema: boundarySchema,
          outputSchema: boundarySchema,
          execute(input) {
            toolInput = input;
            return specialValue();
          },
        }),
      ],
    });

    const result = await app.runAgent<JsonObject, JsonObject>('assistant', {
      input: specialValue(),
    });
    const toolMessage = calls[1]?.messages.find((message) => message.role === 'tool');
    const values = [
      JSON.parse(calls[0]!.messages[1]!.content),
      calls[0]!.tools![0]!.inputSchema,
      calls[0]!.outputSchema,
      toolInput,
      JSON.parse(toolMessage!.content),
      result.output,
    ];

    for (const value of values) {
      const record = value as Record<string, unknown>;
      const nested = record.nested as Record<string, unknown>;
      const arrayItem = (record.items as Array<Record<string, unknown>>)[0]!;

      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
      expect(Object.hasOwn(record, '__proto__')).toBe(true);
      expect(record.__proto__).toEqual({ polluted: true });
      expect(Object.hasOwn(record, 'constructor')).toBe(true);
      expect(Object.hasOwn(record, 'prototype')).toBe(true);
      expect(Object.hasOwn(nested, '__proto__')).toBe(true);
      expect(Object.hasOwn(arrayItem, '__proto__')).toBe(true);
      expect(JSON.stringify(record)).toBe(specialJson);
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test('validates and transforms every schema boundary', async () => {
    const calls: ModelInput[] = [];
    let toolInput: unknown;
    const inputSchemaJson = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    };
    const requestOutputSchemaJson = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const inputSchema = schema<{ query: string }>(
      (value) => ({
        value: { query: String((value as { query?: unknown }).query).toUpperCase() },
      }),
      inputSchemaJson,
    );
    const toolOutputSchema = schema<{ found: string }>(async (value) => ({
      value: { found: (value as { found: string }).found.toUpperCase() },
    }));
    const requestOutputSchema = schema<{ answer: string }>(
      (value) => ({
        value: { answer: (value as { answer: string }).answer.toUpperCase() },
      }),
      requestOutputSchemaJson,
    );
    const model: ModelGateway = {
      stream: streamFrom(async (input) => {
        calls.push(input);
        return calls.length === 1 ? { toolCalls: [lookupCall] } : { output: { answer: 'done' } };
      }),
    };
    const app = createFevex({
      models: { default: model },
      agents: [
        agent('assistant', {
          tools: ['lookup'],
          outputSchema: requestOutputSchema,
        }),
      ],
      tools: [
        defineTool({
          name: 'lookup',
          inputSchema,
          outputSchema: toolOutputSchema,
          execute(input) {
            toolInput = input;
            return { found: 'yes' };
          },
        }),
      ],
    });

    const result = await app.runAgent<unknown, { answer: string }>('assistant', {
      input: 'hello',
    });

    expect(toolInput).toEqual({ query: 'VALUE' });
    expect(calls[0]?.tools?.[0]?.inputSchema).toEqual(inputSchemaJson);
    expect(calls[0]?.outputSchema).toEqual(requestOutputSchemaJson);
    expect(calls[1]?.messages[3]?.content).toBe('{"found":"YES"}');
    expect(result.output).toEqual({ answer: 'DONE' });
  });

  test('emits observable failures for tool and output schema issues', async () => {
    let executed = false;
    const inputEvents: AgentEvent[] = [];
    const invalidInput = schema(() => ({
      issues: [{ message: 'query is required' }],
    }));
    const inputApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            return { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          inputSchema: invalidInput,
          execute() {
            executed = true;
          },
        }),
      ],
      onEvent(event) {
        inputEvents.push(event);
      },
    });

    await expect(inputApp.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      'Input for tool "lookup" does not match inputSchema: query is required',
    );
    expect(executed).toBe(false);
    expect(inputEvents.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.completed',
      'tool.failed',
      'run.failed',
    ]);
    expect(inputEvents[3]?.payload).toEqual({
      step: 1,
      toolCallId: 'call-1',
      toolName: 'lookup',
      error: 'Input for tool "lookup" does not match inputSchema: query is required',
    });

    const toolOutputEvents: AgentEvent[] = [];
    const invalidToolOutput = schema(async () => ({
      issues: [{ message: 'tool result is invalid' }],
    }));
    const toolOutputApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            return { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          outputSchema: invalidToolOutput,
          execute() {
            return { found: false };
          },
        }),
      ],
      onEvent(event) {
        toolOutputEvents.push(event);
      },
    });

    await expect(toolOutputApp.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      'Output from tool "lookup" does not match outputSchema: tool result is invalid',
    );
    expect(toolOutputEvents.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.completed',
      'tool.started',
      'tool.failed',
      'run.failed',
    ]);

    const outputEvents: AgentEvent[] = [];
    const invalidOutput = schema(async () => ({
      issues: [{ message: 'status is invalid' }],
    }));
    const outputApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            return { output: { status: 'bad' } };
          }),
        },
      },
      agents: [agent('assistant', { outputSchema: invalidOutput })],
      onEvent(event) {
        outputEvents.push(event);
      },
    });

    await expect(outputApp.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      'Output from agent "assistant" does not match outputSchema: status is invalid',
    );
    expect(outputEvents.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.failed',
    ]);
  });

  test('isolates synchronous observer errors and continues observing the run', async () => {
    const expectedTypes: AgentEvent['type'][] = [
      'run.started',
      'model.started',
      'model.completed',
      'tool.started',
      'tool.completed',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ];
    const throwingTypes: AgentEvent['type'][] = [
      'run.started',
      'model.started',
      'model.completed',
      'tool.started',
      'tool.completed',
      'run.completed',
    ];

    for (const throwingType of throwingTypes) {
      let modelCalls = 0;
      const observed: AgentEvent[] = [];
      const app = createFevex({
        models: {
          default: {
            stream: streamFrom(async () => {
              modelCalls += 1;
              return modelCalls === 1 ? { toolCalls: [lookupCall] } : { output: 'done' };
            }),
          },
        },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [defineTool({ name: 'lookup', execute: () => 'found' })],
        onEvent(event) {
          observed.push(event);
          if (event.type === throwingType) throw new Error(`observer failed at ${throwingType}`);
        },
      });

      const result = await app.runAgent('assistant', { input: 'hello' });

      expect(result.output).toBe('done');
      expect(observed.map(({ type }) => type)).toEqual(expectedTypes);
      expect(result.events).toEqual(observed);
    }
  });

  test('does not await observer promises and absorbs their rejections', async () => {
    const rejectedTypes: AgentEvent['type'][] = [];
    const rejectedApp = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('assistant')],
      async onEvent(event) {
        rejectedTypes.push(event.type);
        if (event.type === 'model.completed') throw new Error('async observer failed');
      },
    });

    await expect(rejectedApp.runAgent('assistant', { input: 'hello' })).resolves.toMatchObject({
      output: 'done',
    });
    await Promise.resolve();
    expect(rejectedTypes).toEqual([
      'run.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ]);

    const pendingTypes: AgentEvent['type'][] = [];
    const pendingApp = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('assistant')],
      onEvent(event) {
        pendingTypes.push(event.type);
        if (event.type === 'run.started') return new Promise<void>(() => {});
      },
    });
    const streamed: AgentEvent[] = [];

    for await (const event of pendingApp.streamAgent('assistant', { input: 'hello' })) {
      streamed.push(event);
    }

    expect(streamed.map(({ type }) => type)).toEqual(pendingTypes);
    expect(streamed.at(-1)?.type).toBe('run.completed');
  });

  test('resolves direct, named and default models in order', async () => {
    const app = createFevex({
      models: {
        default: modelWithOutput('default'),
        named: modelWithOutput('named'),
      },
      agents: [
        agent('default-agent'),
        agent('named-agent', { model: 'named' }),
        agent('direct-agent', { model: modelWithOutput('direct') }),
      ],
    });

    await expect(
      app.runAgent<unknown, string>('default-agent', { input: '' }),
    ).resolves.toMatchObject({ output: 'default' });
    await expect(
      app.runAgent<unknown, string>('named-agent', { input: '' }),
    ).resolves.toMatchObject({ output: 'named' });
    await expect(
      app.runAgent<unknown, string>('direct-agent', { input: '' }),
    ).resolves.toMatchObject({ output: 'direct' });
  });

  test('validates configuration at startup', () => {
    const model = modelWithOutput('ok');
    const duplicateTool = defineTool({ name: 'lookup', execute() {} });

    expect(() =>
      createFevex({
        models: { default: model },
        agents: [agent('same'), agent('same')],
      }),
    ).toThrow('Agent "same" is duplicated');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [],
        tools: [duplicateTool, duplicateTool],
      }),
    ).toThrow('Tool "lookup" is duplicated');
    expect(() => createFevex({ models: {}, agents: [agent('assistant')] })).toThrow(
      'Default model "default" required by agent "assistant" is not registered',
    );
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [agent('assistant', { model: 'missing' })],
      }),
    ).toThrow('Model "missing" required by agent "assistant" is not registered');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [agent('assistant', { tools: ['missing'] })],
      }),
    ).toThrow('Tool "missing" required by agent "assistant" is not registered');
    expect(() => createFevex({ models: { default: model }, agents: [agent(' ')] })).toThrow(
      'Agent name cannot be empty',
    );
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [agent('assistant', { instructions: ' ' })],
      }),
    ).toThrow('Agent "assistant" instructions cannot be empty');
    expect(() =>
      createFevex({
        models: { ' ': model },
        agents: [],
      }),
    ).toThrow('Model name cannot be empty');
    expect(() =>
      createFevex({
        models: { default: {} as ModelGateway },
        agents: [],
      }),
    ).toThrow('Model "default" must implement stream');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [agent('assistant', { outputSchema: {} as StandardSchemaV1 })],
      }),
    ).toThrow('Output schema for agent "assistant" must implement Standard Schema');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [],
        tools: [
          defineTool({
            name: 'lookup',
            inputSchema: {} as StandardSchemaV1,
            execute() {},
          }),
        ],
      }),
    ).toThrow('Input schema for tool "lookup" must implement Standard Schema');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [agent('assistant', { limits: { maxSteps: 0 } })],
      }),
    ).toThrow('Agent "assistant" limit "maxSteps" must be a positive integer');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [agent('assistant', { limits: { maxToolCalls: -1 } })],
      }),
    ).toThrow('Agent "assistant" limit "maxToolCalls" must be a non-negative integer');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [agent('assistant', { limits: { maxInputTokens: 0 } })],
      }),
    ).toThrow('Agent "assistant" limit "maxInputTokens" must be a positive integer or false');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [],
        workflows: [
          defineWorkflow({ name: 'same', async run() {} }),
          defineWorkflow({ name: 'same', async run() {} }),
        ],
      }),
    ).toThrow('Workflow "same" is duplicated');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [],
        workflows: [{ name: ' ', run() {} }],
      }),
    ).toThrow('Workflow name cannot be empty');
  });

  test('uses stable codes for configuration errors', () => {
    const model = modelWithOutput('ok');
    const duplicateTool = defineTool({ name: 'lookup', execute() {} });
    const cases: Array<{
      code: FevexConfigurationErrorCode;
      config: unknown;
      message: string;
    }> = [
      {
        code: 'INVALID_CONFIG',
        config: null,
        message: 'Fevex config must be an object',
      },
      {
        code: 'INVALID_MODEL',
        config: { models: { default: {} }, agents: [] },
        message: 'Model "default" must implement stream',
      },
      {
        code: 'INVALID_AGENT',
        config: {
          models: { default: model },
          agents: [{ name: 'assistant', instructions: 'Answer.', reasoning: 'ultra' }],
        },
        message: 'Agent "assistant" reasoning is invalid',
      },
      {
        code: 'INVALID_TOOL',
        config: { models: { default: model }, agents: [], tools: [{ name: 'lookup' }] },
        message: 'Tool "lookup" must implement execute',
      },
      {
        code: 'DUPLICATE_AGENT',
        config: {
          models: { default: model },
          agents: [agent('same'), agent('same')],
        },
        message: 'Agent "same" is duplicated',
      },
      {
        code: 'DUPLICATE_TOOL',
        config: {
          models: { default: model },
          agents: [],
          tools: [duplicateTool, duplicateTool],
        },
        message: 'Tool "lookup" is duplicated',
      },
      {
        code: 'MISSING_MODEL',
        config: {
          models: { default: model },
          agents: [agent('assistant', { model: 'missing' })],
        },
        message: 'Model "missing" required by agent "assistant" is not registered',
      },
      {
        code: 'MISSING_TOOL',
        config: {
          models: { default: model },
          agents: [agent('assistant', { tools: ['missing'] })],
        },
        message: 'Tool "missing" required by agent "assistant" is not registered',
      },
    ];

    for (const item of cases) {
      const error = getConfigurationError(item.config);
      expect(error).toMatchObject({
        name: 'FevexConfigurationError',
        code: item.code,
        message: item.message,
      });
    }
  });

  test('rejects malformed JavaScript configuration values', () => {
    const model = modelWithOutput('ok');
    const validRoot = { models: { default: model }, agents: [] };
    const toolProvider = {
      listTools: async () => [],
      callTool: async () => null,
    };
    const cases: Array<[unknown, FevexConfigurationErrorCode, string]> = [
      [{ ...validRoot, models: null }, 'INVALID_CONFIG', 'Fevex config "models" must be an object'],
      [{ ...validRoot, agents: {} }, 'INVALID_CONFIG', 'Fevex config "agents" must be an array'],
      [
        { ...validRoot, workflows: {} },
        'INVALID_CONFIG',
        'Fevex config "workflows" must be an array',
      ],
      [{ ...validRoot, tools: {} }, 'INVALID_CONFIG', 'Fevex config "tools" must be an array'],
      [
        { ...validRoot, onEvent: true },
        'INVALID_CONFIG',
        'Fevex config "onEvent" must be a function',
      ],
      [
        { ...validRoot, runStore: {} },
        'INVALID_CONFIG',
        'Fevex config "runStore" must implement RunStore',
      ],
      [
        { ...validRoot, sandbox: {} },
        'INVALID_CONFIG',
        'Fevex config "sandbox" must implement Sandbox',
      ],
      [{ ...validRoot, tools: [null] }, 'INVALID_TOOL', 'Tool at index 0 must be an object'],
      [
        { ...validRoot, tools: [{ name: 1, execute() {} }] },
        'INVALID_TOOL',
        'Tool name must be a string',
      ],
      [
        { ...validRoot, tools: [{ name: 'lookup', description: 1, execute() {} }] },
        'INVALID_TOOL',
        'Tool "lookup" description must be a string',
      ],
      [
        {
          ...validRoot,
          tools: [
            {
              name: 'code',
              sandbox: { process: { commands: ['node'] } },
              execute() {},
            },
          ],
        },
        'INVALID_TOOL',
        'Tool "code" requires Fevex config "sandbox"',
      ],
      [
        {
          ...validRoot,
          sandbox: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }) },
          tools: [
            {
              name: 'code',
              sandbox: { process: { commands: [1] } },
              execute() {},
            },
          ],
        },
        'INVALID_TOOL',
        'Tool "code" sandbox.process.commands must contain non-empty strings',
      ],
      [{ ...validRoot, agents: [null] }, 'INVALID_AGENT', 'Agent at index 0 must be an object'],
      [
        { ...validRoot, agents: [{ name: 1, instructions: 'Answer.' }] },
        'INVALID_AGENT',
        'Agent name must be a string',
      ],
      [
        { ...validRoot, agents: [{ name: 'assistant', instructions: 1 }] },
        'INVALID_AGENT',
        'Agent "assistant" instructions must be a string',
      ],
      [
        { ...validRoot, agents: [{ name: 'assistant', instructions: 'Answer.', model: '' }] },
        'INVALID_MODEL',
        'Model name required by agent "assistant" cannot be empty',
      ],
      [
        { ...validRoot, agents: [{ name: 'assistant', instructions: 'Answer.', tools: {} }] },
        'INVALID_AGENT',
        'Agent "assistant" tools must be an array',
      ],
      [
        { ...validRoot, agents: [{ name: 'assistant', instructions: 'Answer.', tools: [1] }] },
        'INVALID_AGENT',
        'Tool name at index 0 for agent "assistant" must be a non-empty string',
      ],
      [
        {
          ...validRoot,
          agents: [{ name: 'assistant', instructions: 'Answer.', tools: ['lookup', 'lookup'] }],
          tools: [{ name: 'lookup', execute() {} }],
        },
        'DUPLICATE_TOOL',
        'Tool "lookup" is duplicated in agent "assistant"',
      ],
      [
        {
          ...validRoot,
          agents: [{ name: 'assistant', instructions: 'Answer.', modelOptions: [] }],
        },
        'INVALID_AGENT',
        'Agent "assistant" modelOptions must be an object',
      ],
      [
        { ...validRoot, agents: [{ name: 'assistant', instructions: 'Answer.', limits: [] }] },
        'INVALID_AGENT',
        'Agent "assistant" limits must be an object',
      ],
      [
        { ...validRoot, workflows: [null] },
        'INVALID_WORKFLOW',
        'Workflow at index 0 must be an object',
      ],
      [
        { ...validRoot, workflows: [{ name: 1, run() {} }] },
        'INVALID_WORKFLOW',
        'Workflow name must be a string',
      ],
      [
        { ...validRoot, workflows: [{ name: 'flow' }] },
        'INVALID_WORKFLOW',
        'Workflow "flow" must implement run',
      ],
      [
        {
          ...validRoot,
          workflows: [
            { name: 'flow', run() {} },
            { name: 'flow', run() {} },
          ],
        },
        'DUPLICATE_WORKFLOW',
        'Workflow "flow" is duplicated',
      ],
      [
        { ...validRoot, workflows: [{ name: 'flow', version: '', run() {} }] },
        'INVALID_WORKFLOW',
        'Workflow "flow" version must be a non-empty string',
      ],
      [
        { ...validRoot, workflows: [{ name: 'flow', version: 2, run() {} }] },
        'INVALID_WORKFLOW',
        'Workflow "flow" version must be a non-empty string',
      ],
      [
        { ...validRoot, contextProviders: [null] },
        'INVALID_CONTEXT_PROVIDER',
        'Context provider at index 0 must have a name and read',
      ],
      [
        {
          ...validRoot,
          contextProviders: [
            { name: 'docs', read: async () => [] },
            { name: 'docs', read: async () => [] },
          ],
        },
        'DUPLICATE_CONTEXT_PROVIDER',
        'Context provider "docs" is duplicated',
      ],
      [
        { ...validRoot, policies: [{ name: 'p' }] },
        'INVALID_POLICY',
        'Policy at index 0 must have a name and authorize',
      ],
      [
        { ...validRoot, connections: [{ name: '', provider: toolProvider, allowlist: ['a'] }] },
        'INVALID_CONNECTION',
        'Connection name must be a non-empty string',
      ],
      [
        { ...validRoot, connections: [{ name: 'crm', provider: {}, allowlist: ['a'] }] },
        'INVALID_CONNECTION',
        'Connection "crm" provider must implement listTools and callTool',
      ],
      [
        { ...validRoot, connections: [{ name: 'crm', provider: toolProvider, allowlist: [] }] },
        'INVALID_CONNECTION',
        'Connection "crm" allowlist must be a non-empty array',
      ],
    ];

    for (const [config, code, message] of cases) {
      expect(getConfigurationError(config)).toMatchObject({ code, message });
    }
  });

  test('captures a shallow configuration snapshot without freezing caller values', async () => {
    const calls: ModelInput[] = [];
    const originalEvents: AgentEvent[] = [];
    let changedObserverCalls = 0;
    let originalExecutions = 0;
    let changedExecutions = 0;
    const originalModel: ModelGateway = {
      stream: streamFrom(async (input) => {
        calls.push(input);
        return calls.length === 1 ? { toolCalls: [lookupCall] } : { output: 'done' };
      }),
    };
    const models = { default: originalModel };
    const modelOptions = { temperature: 0.2 };
    const limits = { maxSteps: 2, maxToolCalls: 1 };
    const assistant = defineAgent({
      name: 'assistant',
      instructions: 'Original instructions.',
      tools: ['lookup'],
      modelOptions,
      limits,
    });
    const lookup = defineTool({
      name: 'lookup',
      execute() {
        originalExecutions += 1;
        return 'found';
      },
    });
    const agents = [assistant];
    const tools = [lookup];
    const config = {
      models,
      agents,
      tools,
      onEvent(event: AgentEvent) {
        originalEvents.push(event);
      },
    };
    const app = createFevex(config);

    assistant.instructions = 'Changed instructions.';
    assistant.tools[0] = 'hidden';
    limits.maxSteps = 1;
    modelOptions.temperature = 1;
    lookup.name = 'changed';
    lookup.execute = () => {
      changedExecutions += 1;
      return 'changed';
    };
    agents.length = 0;
    tools.length = 0;
    models.default = modelWithOutput('changed');
    config.onEvent = () => {
      changedObserverCalls += 1;
    };

    await expect(
      app.runAgent<string, string>('assistant', { input: 'hello' }),
    ).resolves.toMatchObject({ output: 'done' });
    expect(originalExecutions).toBe(1);
    expect(changedExecutions).toBe(0);
    expect(changedObserverCalls).toBe(0);
    expect(originalEvents.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.messages[0]).toEqual({
      role: 'system',
      content: 'Original instructions.',
    });
    expect(calls[0]?.tools?.[0]?.name).toBe('lookup');
    expect(calls[0]?.modelOptions).toEqual({ temperature: 0.2 });
  });

  test('rejects unknown agents and non-serializable input', async () => {
    const app = createFevex({
      models: { default: modelWithOutput('ok') },
      agents: [agent('assistant')],
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    await expect(app.runAgent('missing', { input: 'hello' })).rejects.toThrow(
      'Agent "missing" is not registered',
    );
    class CustomValue {}

    for (const input of [
      undefined,
      () => {},
      Symbol('input'),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      new Map(),
      new Set(),
      new CustomValue(),
      [undefined],
      cyclic,
    ]) {
      await expect(app.runAgent('assistant', { input })).rejects.toThrow(
        'Run input must be a string or JSON-serializable value',
      );
    }
  });

  test('rejects incomplete model results', async () => {
    let noFinalCalls = 0;
    const noOutputModel = {
      stream: streamFrom(async () => {
        return {};
      }),
    };
    const noFinalOutputModel = {
      stream: streamFrom(async () => {
        noFinalCalls += 1;
        return noFinalCalls === 1 ? { toolCalls: [lookupCall] } : {};
      }),
    };
    const app = createFevex({
      models: {
        'no-output': noOutputModel,
        'no-final-output': noFinalOutputModel,
      },
      agents: [
        agent('no-output', {
          model: 'no-output',
        }),
        agent('no-final-output', {
          model: 'no-final-output',
          tools: ['lookup'],
        }),
      ],
      tools: [defineTool({ name: 'lookup', execute: () => 'found' })],
    });

    await expect(app.runAgent('no-output', { input: 'hello' })).rejects.toThrow(
      'Model for agent "no-output" returned no output',
    );
    await expect(app.runAgent('no-final-output', { input: 'hello' })).rejects.toThrow(
      'Model for agent "no-final-output" returned no output',
    );
  });

  test('rejects invalid or unavailable tool calls before execution', async () => {
    let executions = 0;
    const lookup = defineTool({
      name: 'lookup',
      execute() {
        executions += 1;
      },
    });
    const hidden = defineTool({
      name: 'hidden',
      execute() {
        executions += 1;
      },
    });
    const appFor = (toolCalls: ToolCall[]) =>
      createFevex({
        models: {
          default: {
            stream: streamFrom(async () => {
              return { toolCalls };
            }),
          },
        },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [lookup, hidden],
      });

    await expect(
      appFor([{ ...lookupCall, id: '' }]).runAgent('assistant', { input: 'hello' }),
    ).rejects.toThrow('Tool call id cannot be empty');
    await expect(
      appFor([{ ...lookupCall, name: '' }]).runAgent('assistant', { input: 'hello' }),
    ).rejects.toThrow('Tool call name cannot be empty');
    await expect(
      appFor([{ ...lookupCall, name: 'hidden' }]).runAgent('assistant', { input: 'hello' }),
    ).rejects.toThrow('Tool "hidden" is not available to agent "assistant"');

    const limitedApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            return { toolCalls: [lookupCall, { ...lookupCall, id: 'call-2' }] };
          }),
        },
      },
      agents: [
        agent('assistant', {
          tools: ['lookup'],
          limits: { maxToolCalls: 1 },
        }),
      ],
      tools: [lookup],
    });

    await expect(limitedApp.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      'Agent "assistant" exceeded maxToolCalls limit of 1',
    );
    expect(executions).toBe(0);
  });

  test('rejects duplicated tool call ids before repeating an effect', async () => {
    let batchExecutions = 0;
    const duplicateBatchApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            return {
              toolCalls: [lookupCall, { ...lookupCall, name: 'lookup', input: { query: 'other' } }],
            };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          execute() {
            batchExecutions += 1;
          },
        }),
      ],
    });

    await expect(duplicateBatchApp.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      /Tool call id "call-1" is duplicated in run/,
    );
    expect(batchExecutions).toBe(0);

    let modelCalls = 0;
    let repeatedExecutions = 0;
    const duplicateStepApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            modelCalls += 1;
            return { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          execute() {
            repeatedExecutions += 1;
            return 'found';
          },
        }),
      ],
    });

    await expect(duplicateStepApp.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      /Tool call id "call-1" is duplicated in run/,
    );
    expect(modelCalls).toBe(2);
    expect(repeatedExecutions).toBe(1);
  });

  test('stops an unconfigured infinite loop at the default maxSteps', async () => {
    let calls = 0;
    let executions = 0;
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            calls += 1;
            return { toolCalls: [{ ...lookupCall, id: `call-${calls}` }] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          execute() {
            executions += 1;
            return 'found';
          },
        }),
      ],
    });

    await expect(app.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      'Agent "assistant" reached maxSteps limit of 8',
    );
    expect(calls).toBe(8);
    expect(executions).toBe(7);
  });

  test('applies tool and cumulative token limits', async () => {
    const noToolsCalls: ModelInput[] = [];
    const noToolsApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            noToolsCalls.push(input);
            return { output: 'done' };
          }),
        },
      },
      agents: [
        agent('no-tools', {
          tools: ['lookup'],
          limits: { maxToolCalls: 0 },
        }),
      ],
      tools: [defineTool({ name: 'lookup', execute: () => 'unused' })],
    });

    await expect(noToolsApp.runAgent('no-tools', { input: 'hello' })).resolves.toMatchObject({
      output: 'done',
    });
    expect(noToolsCalls[0]?.tools).toBeUndefined();

    let exactCalls = 0;
    const exactOutputCaps: Array<number | undefined> = [];
    const exactApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            exactCalls += 1;
            exactOutputCaps.push(input.maxOutputTokens);
            return exactCalls === 1
              ? {
                  toolCalls: [lookupCall],
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              : {
                  output: 'done',
                  usage: { inputTokens: 2, outputTokens: 2 },
                };
          }),
        },
      },
      agents: [
        agent('exact', {
          tools: ['lookup'],
          limits: { maxInputTokens: 3, maxOutputTokens: 3 },
        }),
      ],
      tools: [defineTool({ name: 'lookup', execute: () => 'found' })],
    });

    await expect(exactApp.runAgent('exact', { input: 'hello' })).resolves.toMatchObject({
      output: 'done',
      usage: { inputTokens: 3, outputTokens: 3 },
    });
    expect(exactOutputCaps).toEqual([3, 2]);

    const exceededApp = createFevex({
      models: {
        default: modelWithOutput('unused'),
        exceeded: {
          stream: streamFrom(async () => {
            return { output: 'too much', usage: { inputTokens: 3 } };
          }),
        },
        missing: modelWithOutput('unmeasured'),
      },
      agents: [
        agent('exceeded', { model: 'exceeded', limits: { maxInputTokens: 2 } }),
        agent('missing', { model: 'missing', limits: { maxOutputTokens: 2 } }),
        agent('unlimited', {
          model: 'missing',
          limits: { maxInputTokens: false, maxOutputTokens: false },
        }),
      ],
    });

    await expect(exceededApp.runAgent('exceeded', { input: 'hello' })).rejects.toThrow(
      'Agent "exceeded" exceeded maxInputTokens limit of 2',
    );
    await expect(exceededApp.runAgent('missing', { input: 'hello' })).rejects.toThrow(
      'Agent "missing" cannot enforce maxOutputTokens: model usage.outputTokens is missing or invalid',
    );
    await expect(exceededApp.runAgent('unlimited', { input: 'hello' })).resolves.toMatchObject({
      output: 'unmeasured',
    });

    for (const [limitName, usage] of [
      ['maxInputTokens', { inputTokens: 2, outputTokens: 1 }],
      ['maxOutputTokens', { inputTokens: 1, outputTokens: 2 }],
    ] as const) {
      let toolExecuted = false;
      const exhaustedApp = createFevex({
        models: {
          default: {
            stream: streamFrom(async () => {
              return { toolCalls: [lookupCall], usage };
            }),
          },
        },
        agents: [
          agent('exhausted', {
            tools: ['lookup'],
            limits: { [limitName]: 2 },
          }),
        ],
        tools: [
          defineTool({
            name: 'lookup',
            execute() {
              toolExecuted = true;
            },
          }),
        ],
      });

      await expect(exhaustedApp.runAgent('exhausted', { input: 'hello' })).rejects.toThrow(
        `Agent "exhausted" exhausted ${limitName} limit of 2 before completing`,
      );
      expect(toolExecuted).toBe(false);
    }
  });

  test('streams the same events as observers and preserves failures', async () => {
    const observed: AgentEvent[] = [];
    let calls = 0;
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            calls += 1;
            return calls === 1 ? { toolCalls: [lookupCall] } : { output: 'done' };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [defineTool({ name: 'lookup', execute: () => 'found' })],
      onEvent(event) {
        observed.push(event);
      },
    });
    const streamed: AgentEvent[] = [];

    for await (const event of app.streamAgent('assistant', { input: 'hello' })) {
      streamed.push(event);
    }

    expect(streamed).toEqual(observed);
    expect(streamed.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.completed',
      'tool.started',
      'tool.completed',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ]);
    expect(streamed.at(-1)?.payload).toEqual({ output: 'done' });

    const providerError = new Error('stream failed');
    const failedApp = createFevex({
      models: {
        default: {
          async *stream() {
            yield { type: 'output.delta', delta: 'partial' };
            throw providerError;
          },
        },
      },
      agents: [agent('assistant')],
    });
    const failedEvents: AgentEvent[] = [];
    let thrown: unknown;

    try {
      for await (const event of failedApp.streamAgent('assistant', { input: 'hello' })) {
        failedEvents.push(event);
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(providerError);
    expect(failedEvents.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.output.delta',
      'run.failed',
    ]);
    await expect(failedApp.listEvents(failedEvents[0]!.runId)).resolves.toEqual(failedEvents);
  });

  test('does not execute tools before the model terminal event', async () => {
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    let modelCalls = 0;
    let toolExecuted = false;
    const app = createFevex({
      models: {
        default: {
          async *stream() {
            modelCalls += 1;
            if (modelCalls === 1) {
              yield { type: 'output.delta', delta: 'checking' };
              await terminalGate;
              yield {
                type: 'completed',
                result: { output: 'checking', toolCalls: [lookupCall] },
              };
              return;
            }
            yield { type: 'output.delta', delta: 'done' };
            yield { type: 'completed', result: { output: 'done' } };
          },
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          execute() {
            toolExecuted = true;
            return 'found';
          },
        }),
      ],
    });
    const events = app.streamAgent('assistant', { input: 'hello' })[Symbol.asyncIterator]();

    await events.next();
    await events.next();
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: 'model.output.delta',
        payload: { step: 1, delta: 'checking' },
      },
    });
    expect(toolExecuted).toBe(false);

    releaseTerminal();
    while (!(await events.next()).done) {}
    expect(toolExecuted).toBe(true);
  });

  test('keeps stream backpressure and stops when the consumer abandons it', async () => {
    let modelCalls = 0;
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            modelCalls += 1;
            return { output: 'done' };
          }),
        },
      },
      agents: [agent('assistant')],
    });
    const iterator = app.streamAgent('assistant', { input: 'hello' })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'run.started' },
    });
    expect(modelCalls).toBe(0);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'model.started' },
    });
    expect(modelCalls).toBe(0);

    await iterator.return?.();
    expect(modelCalls).toBe(0);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('persists runs and continues or compacts session history', async () => {
    const calls: ModelInput[] = [];
    const outputs = ['first answer', 'second answer', 'third answer'];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            calls.push(input);
            return { output: outputs[calls.length - 1] };
          }),
        },
      },
      agents: [agent('assistant')],
    });

    const first = await app.runAgent<string, string>('assistant', { input: 'first question' });
    expect(first.runId).not.toBe(first.sessionId);
    await expect(app.getRun(first.runId)).resolves.toMatchObject({
      id: first.runId,
      sessionId: first.sessionId,
      agentName: 'assistant',
      status: 'completed',
      output: 'first answer',
    });

    const firstEvents = await app.listEvents(first.runId);
    expect(firstEvents.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
    await expect(app.listEvents(first.runId, { after: firstEvents[1]!.id })).resolves.toEqual(
      firstEvents.slice(2),
    );

    const second = await app.runAgent<string, string>('assistant', {
      input: 'second question',
      sessionId: first.sessionId,
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(calls[1]?.messages).toEqual([
      { role: 'system', content: 'Answer clearly.' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]);
    await expect(
      app.listEvents(first.runId, {
        after: (await app.listEvents(second.runId))[0]!.id,
      }),
    ).rejects.toThrow(/does not exist in run/);

    const compacted = await app.compactSession(first.sessionId, 'The user asked two questions.');
    expect(compacted.history).toEqual([
      { role: 'system', content: 'The user asked two questions.' },
    ]);
    await app.runAgent('assistant', {
      input: 'third question',
      sessionId: first.sessionId,
    });
    expect(calls[2]?.messages).toEqual([
      { role: 'system', content: 'Answer clearly.' },
      { role: 'system', content: 'The user asked two questions.' },
      { role: 'user', content: 'third question' },
    ]);

    await expect(
      app.runAgent('assistant', {
        input: 'unknown',
        sessionId: 'missing-session',
      }),
    ).rejects.toThrow('Session "missing-session" does not exist');
    await expect(app.compactSession(first.sessionId, '  ')).rejects.toThrow(
      'Session summary must be a non-empty string',
    );
  });

  test('starts, cancels and releases a consultable background run', async () => {
    const calls: ModelInput[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    let finishModel!: (value: { output: string }) => void;
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            calls.push(input);
            if (calls.length > 1) return { output: 'continued' };
            markStarted();
            return new Promise<{ output: string }>((resolve) => {
              finishModel = resolve;
            });
          }),
        },
      },
      agents: [agent('assistant')],
      onEvent(event) {
        if (event.type === 'run.cancelled') markCancelled();
      },
    });

    const run = await app.startAgent('assistant', { input: 'cancelled question' });
    expect(run).toMatchObject({ status: 'running', agentName: 'assistant' });
    await started;
    await expect(app.getRun(run.id)).resolves.toMatchObject({ status: 'running' });
    await expect(
      app.runAgent('assistant', {
        input: 'concurrent',
        sessionId: run.sessionId,
      }),
    ).rejects.toThrow(`Session "${run.sessionId}" already has an active run`);
    await expect(app.compactSession(run.sessionId, 'summary')).rejects.toThrow(
      `Session "${run.sessionId}" has an active run`,
    );

    await expect(app.cancelRun(run.id)).resolves.toBe(true);
    await cancelled;
    await expect(app.getRun(run.id)).resolves.toMatchObject({
      status: 'cancelled',
      error: 'aborted',
    });
    expect((await app.listEvents(run.id)).at(-1)).toMatchObject({
      type: 'run.cancelled',
      payload: { reason: 'aborted' },
    });
    await expect(app.cancelRun(run.id)).resolves.toBe(false);
    await expect(app.cancelRun('missing-run')).resolves.toBe(false);

    await app.runAgent('assistant', {
      input: 'continued question',
      sessionId: run.sessionId,
    });
    expect(calls[1]?.messages).toEqual([
      { role: 'system', content: 'Answer clearly.' },
      { role: 'user', content: 'continued question' },
    ]);
    finishModel({ output: 'late' });
  });

  test('captures background failures and persists abandoned streams', async () => {
    const providerError = new Error('background failed');
    const calls: ModelInput[] = [];
    let markFailed!: () => void;
    const failed = new Promise<void>((resolve) => {
      markFailed = resolve;
    });
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            calls.push(input);
            if (calls.length > 1) return { output: 'recovered' };
            throw providerError;
          }),
        },
      },
      agents: [agent('assistant')],
      onEvent(event) {
        if (event.type === 'run.failed') markFailed();
      },
    });
    const background = await app.startAgent('assistant', { input: 'fail' });
    await failed;
    await expect(app.getRun(background.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'background failed',
    });
    await app.runAgent('assistant', {
      input: 'recover',
      sessionId: background.sessionId,
    });
    expect(calls[1]?.messages).toEqual([
      { role: 'system', content: 'Answer clearly.' },
      { role: 'user', content: 'recover' },
    ]);

    const streamApp = createFevex({
      models: { default: modelWithOutput('unused') },
      agents: [agent('assistant')],
    });
    const iterator = streamApp
      .streamAgent('assistant', { input: 'abandon' })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toMatchObject({ done: false, value: { type: 'run.started' } });
    const runId = first.value!.runId;
    await iterator.return?.();
    await expect(streamApp.getRun(runId)).resolves.toMatchObject({ status: 'cancelled' });
    expect((await streamApp.listEvents(runId)).map(({ type }) => type)).toEqual([
      'run.started',
      'run.cancelled',
    ]);
  });

  test('uses a configured RunStore and protects in-memory snapshots', async () => {
    let savedRuns = 0;
    let savedSessions = 0;
    let appendedEvents = 0;
    let commits = 0;
    class TrackingRunStore extends InMemoryRunStore {
      creates = 0;

      override async createExecution(
        ...args: Parameters<InMemoryRunStore['createExecution']>
      ): Promise<boolean> {
        this.creates += 1;
        return super.createExecution(...args);
      }

      override async saveRun(...args: Parameters<InMemoryRunStore['saveRun']>): Promise<void> {
        savedRuns += 1;
        await super.saveRun(...args);
      }

      override async saveSession(
        ...args: Parameters<InMemoryRunStore['saveSession']>
      ): Promise<void> {
        savedSessions += 1;
        await super.saveSession(...args);
      }

      override async appendEvent(
        ...args: Parameters<InMemoryRunStore['appendEvent']>
      ): Promise<void> {
        appendedEvents += 1;
        await super.appendEvent(...args);
      }

      override async commitExecution(
        ...args: Parameters<InMemoryRunStore['commitExecution']>
      ): Promise<boolean> {
        commits += 1;
        return super.commitExecution(...args);
      }
    }
    const runStore = new TrackingRunStore();
    const app = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('assistant')],
      runStore,
    });

    const result = await app.runAgent('assistant', { input: 'hello' });
    expect(runStore.creates).toBe(1);
    expect(savedRuns).toBe(0);
    expect(savedSessions).toBe(0);
    expect(appendedEvents).toBe(0);
    expect(commits).toBe(4);

    const snapshot = await runStore.getRun(result.runId);
    snapshot!.status = 'failed';
    await expect(runStore.getRun(result.runId)).resolves.toMatchObject({ status: 'completed' });
  });

  test('rejects non-serializable tool input and output', async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let inputToolCalled = false;
    const inputApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            return { toolCalls: [{ ...lookupCall, input: cyclic as never }] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          execute() {
            inputToolCalled = true;
          },
        }),
      ],
    });

    await expect(inputApp.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      'Input for tool "lookup" must be JSON-serializable',
    );
    expect(inputToolCalled).toBe(false);

    for (const output of [
      undefined,
      () => {},
      Symbol('output'),
      1n,
      Number.NaN,
      new Date(),
      new Map(),
      cyclic,
    ]) {
      const outputApp = createFevex({
        models: {
          default: {
            stream: streamFrom(async () => {
              return { toolCalls: [lookupCall] };
            }),
          },
        },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [defineTool({ name: 'lookup', execute: () => output })],
      });

      await expect(outputApp.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
        'Output from tool "lookup" must be JSON-serializable',
      );
    }
  });

  test('rejects non-serializable final and schema-transformed outputs', async () => {
    const finalApp = createFevex({
      models: { default: modelWithOutput(new Date()) },
      agents: [agent('assistant')],
    });

    await expect(finalApp.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      'Output from agent "assistant" must be JSON-serializable',
    );

    const transformedApp = createFevex({
      models: { default: modelWithOutput('date') },
      agents: [
        agent('assistant', {
          outputSchema: schema(() => ({ value: new Date() })),
        }),
      ],
    });

    await expect(transformedApp.runAgent('assistant', { input: 'hello' })).rejects.toThrow(
      'Output from agent "assistant" must be JSON-serializable',
    );
  });

  test('fails before the model when active schemas are not transportable', async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            modelCalls += 1;
            return { output: 'unexpected' };
          }),
        },
      },
      agents: [
        agent('assistant', {
          outputSchema: schemaOnly((value) => ({ value: value as string })),
        }),
      ],
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(app.runAgent('assistant', { input: 'hello' })).rejects.toMatchObject({
      code: SCHEMA_NOT_TRANSPORTABLE,
      message:
        'Output schema for agent "assistant" is not transportable: schema does not implement Standard JSON Schema',
    });
    expect(modelCalls).toBe(0);
    expect(events).toEqual([]);
  });

  test('fails before the model when schema conversion throws or returns invalid JSON Schema', async () => {
    const throwingSchema = schema((value) => ({ value: value as string }), { type: 'string' });
    (throwingSchema['~standard'].jsonSchema as unknown as { output: () => JsonObject }).output =
      () => {
        throw new Error('unsupported target');
      };
    const outputApp = createFevex({
      models: { default: modelWithOutput('unexpected') },
      agents: [agent('assistant', { outputSchema: throwingSchema })],
    });

    await expect(outputApp.runAgent('assistant', { input: 'hello' })).rejects.toMatchObject({
      code: SCHEMA_NOT_TRANSPORTABLE,
      message: 'Output schema for agent "assistant" is not transportable: unsupported target',
    });

    const invalidJsonSchema = schema((value) => ({ value: value as { query: string } }), {
      type: 'object',
    });
    (invalidJsonSchema['~standard'].jsonSchema as unknown as { input: () => JsonObject }).input =
      () => new Date() as never;
    let modelCalls = 0;
    const inputApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            modelCalls += 1;
            return { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          inputSchema: invalidJsonSchema,
          execute() {},
        }),
      ],
    });

    await expect(inputApp.runAgent('assistant', { input: 'hello' })).rejects.toMatchObject({
      code: SCHEMA_NOT_TRANSPORTABLE,
      message:
        'Input schema for tool "lookup" is not transportable: JSON Schema must be JSON-serializable',
    });
    expect(modelCalls).toBe(0);
  });

  test('checks cancellation and preserves provider errors', async () => {
    let abortedModelCalled = false;
    const providerError = new Error('provider failed');
    const app = createFevex({
      models: {},
      agents: [
        agent('aborted', {
          model: {
            stream: streamFrom(async () => {
              abortedModelCalled = true;
              return { output: 'unexpected' };
            }),
          },
        }),
        agent('failure', {
          model: {
            stream: streamFrom(async () => {
              throw providerError;
            }),
          },
        }),
      ],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      app.runAgent('aborted', { input: 'hello', signal: controller.signal }),
    ).rejects.toThrow();
    expect(abortedModelCalled).toBe(false);
    await expect(app.runAgent('failure', { input: 'hello' })).rejects.toBe(providerError);
  });

  test('cancels non-cooperative model and tool work without starting another step', async () => {
    const modelController = new AbortController();
    const modelAbort = new Error('model aborted');
    const modelEvents: AgentEvent[] = [];
    let markModelStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    let finishModel!: (value: { output: string }) => void;
    const modelApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            markModelStarted();
            return new Promise<{ output: string }>((resolve) => {
              finishModel = resolve;
            });
          }),
        },
      },
      agents: [agent('assistant')],
      onEvent(event) {
        modelEvents.push(event);
        if (event.type === 'run.cancelled') throw new Error('observer failed during cancellation');
      },
    });
    const modelRun = modelApp.runAgent('assistant', {
      input: 'hello',
      signal: modelController.signal,
    });

    await modelStarted;
    modelController.abort(modelAbort);
    await expect(modelRun).rejects.toBe(modelAbort);
    expect(modelEvents.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'run.cancelled',
    ]);
    expect(modelEvents.at(-1)?.payload).toEqual({ reason: 'aborted' });
    finishModel({ output: 'late' });
    await Promise.resolve();
    expect(modelEvents.some(({ type }) => type === 'run.completed')).toBe(false);

    const toolController = new AbortController();
    const toolAbort = new DOMException('Timed out', 'TimeoutError');
    const toolEvents: AgentEvent[] = [];
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    let finishTool!: (value: string) => void;
    let modelCalls = 0;
    const toolApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            modelCalls += 1;
            return modelCalls === 1 ? { toolCalls: [lookupCall] } : { output: 'unexpected' };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          execute() {
            markToolStarted();
            return new Promise<string>((resolve) => {
              finishTool = resolve;
            });
          },
        }),
      ],
      onEvent(event) {
        toolEvents.push(event);
      },
    });
    const toolRun = toolApp.runAgent('assistant', {
      input: 'hello',
      signal: toolController.signal,
    });

    await toolStarted;
    toolController.abort(toolAbort);
    await expect(toolRun).rejects.toBe(toolAbort);
    expect(modelCalls).toBe(1);
    expect(toolEvents.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.completed',
      'tool.started',
      'run.cancelled',
    ]);
    expect(toolEvents.at(-1)?.payload).toEqual({ reason: 'timeout' });
    expect(toolEvents.some(({ type }) => type === 'tool.failed')).toBe(false);
    finishTool('late');
  });

  test('cancels asynchronous schema validation', async () => {
    const controller = new AbortController();
    const abortError = new Error('validation aborted');
    const events: AgentEvent[] = [];
    let markValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve;
    });
    let finishValidation!: (result: { value: string }) => void;
    const outputSchema = schema<string>(
      () => {
        markValidationStarted();
        return new Promise<{ value: string }>((resolve) => {
          finishValidation = resolve;
        });
      },
      { type: 'string' },
    );
    const app = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('assistant', { outputSchema })],
      onEvent(event) {
        events.push(event);
      },
    });
    const run = app.runAgent('assistant', {
      input: 'hello',
      signal: controller.signal,
    });

    await validationStarted;
    controller.abort(abortError);
    await expect(run).rejects.toBe(abortError);
    expect(events.map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.cancelled',
    ]);
    finishValidation({ value: 'late' });
  });

  test('checks cancellation around tools and preserves tool errors', async () => {
    const beforeToolController = new AbortController();
    let beforeToolCalled = false;
    const beforeToolApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            beforeToolController.abort();
            return { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          execute() {
            beforeToolCalled = true;
          },
        }),
      ],
    });

    await expect(
      beforeToolApp.runAgent('assistant', {
        input: 'hello',
        signal: beforeToolController.signal,
      }),
    ).rejects.toThrow();
    expect(beforeToolCalled).toBe(false);

    const beforeModelController = new AbortController();
    let modelCalls = 0;
    const beforeModelApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            modelCalls += 1;
            return { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          execute() {
            beforeModelController.abort();
            return 'found';
          },
        }),
      ],
    });

    await expect(
      beforeModelApp.runAgent('assistant', {
        input: 'hello',
        signal: beforeModelController.signal,
      }),
    ).rejects.toThrow();
    expect(modelCalls).toBe(1);

    const toolError = new Error('tool failed');
    const failureTypes: string[] = [];
    const observerError = new Error('observer failed');
    const errorApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            return { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          execute() {
            throw toolError;
          },
        }),
      ],
      onEvent(event) {
        failureTypes.push(event.type);
        if (event.type === 'tool.failed' || event.type === 'run.failed') {
          throw observerError;
        }
      },
    });

    await expect(errorApp.runAgent('assistant', { input: 'hello' })).rejects.toBe(toolError);
    expect(failureTypes).toEqual([
      'run.started',
      'model.started',
      'model.completed',
      'tool.started',
      'tool.failed',
      'run.failed',
    ]);
  });

  test('pauses for approval and resumes from another runtime', async () => {
    const store = new InMemoryRunStore();
    let executions = 0;
    const configuredModel = (): ModelGateway => ({
      stateCodec: {
        serialize(state) {
          return structuredClone(state) as JsonObject;
        },
        restore(state) {
          return structuredClone(state);
        },
      },
      stream: streamFrom(async (input) => {
        if (input.providerState === undefined) {
          return {
            toolCalls: [lookupCall],
            providerState: { turn: 1 },
          };
        }
        expect(input.providerState).toEqual({ turn: 1 });
        return { output: 'approved' };
      }),
    });
    const configuredTool = () =>
      defineTool({
        name: 'lookup',
        risk: 'write',
        approval: 'required',
        idempotency: 'keyed',
        execute(_input, context) {
          executions += 1;
          expect(context.attempt).toBe(1);
          expect(context.idempotencyKey).toBeTruthy();
          return 'found';
        },
      });
    const first = createFevex({
      models: { default: configuredModel() },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [configuredTool()],
      runStore: store,
    });

    let paused!: RunPausedError;
    try {
      await first.runAgent('assistant', { input: 'hello' });
    } catch (error) {
      expect(error).toBeInstanceOf(RunPausedError);
      paused = error as RunPausedError;
    }
    expect(paused.pause.type).toBe('approval');
    expect(executions).toBe(0);

    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const second = createFevex({
      models: { default: configuredModel() },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [configuredTool()],
      runStore: store,
      onEvent(event) {
        if (event.runId === paused.runId && event.type === 'run.completed') complete();
      },
    });
    const pause = paused.pause.type === 'approval' ? paused.pause.approval : undefined;
    expect(pause).toBeDefined();
    await second.resumeRun(paused.runId, {
      type: 'approval',
      approvalId: pause!.id,
      decision: 'approve',
      actor: { id: 'reviewer-1' },
    });
    await completed;

    expect(await second.getRun(paused.runId)).toMatchObject({
      status: 'completed',
      output: 'approved',
    });
    expect(executions).toBe(1);
    expect((await second.listEvents(paused.runId)).map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.completed',
      'approval.requested',
      'run.paused',
      'run.resumed',
      'approval.resolved',
      'tool.started',
      'tool.completed',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ]);
  });

  test('rejects an approval once and cancels paused runs with terminal events', async () => {
    const store = new InMemoryRunStore();
    const makeApp = () =>
      createFevex({
        models: {
          default: {
            stream: streamFrom(async () => {
              return { toolCalls: [lookupCall] };
            }),
          },
        },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [
          defineTool({
            name: 'lookup',
            approval: 'required',
            execute() {
              throw new Error('must not execute');
            },
          }),
        ],
        runStore: store,
      });
    const first = makeApp();
    let firstPause!: RunPausedError;
    await first.runAgent('assistant', { input: 'one' }).catch((error) => {
      firstPause = error;
    });
    const approval = firstPause.pause.type === 'approval' ? firstPause.pause.approval : undefined;
    const rejected = await makeApp().resumeRun(firstPause.runId, {
      type: 'approval',
      approvalId: approval!.id,
      decision: 'reject',
      actor: { id: 'reviewer' },
    });
    expect(rejected.status).toBe('cancelled');
    expect((await first.listEvents(firstPause.runId)).map(({ type }) => type).slice(-2)).toEqual([
      'approval.resolved',
      'run.cancelled',
    ]);
    await expect(
      makeApp().resumeRun(firstPause.runId, {
        type: 'approval',
        approvalId: approval!.id,
        decision: 'approve',
        actor: { id: 'reviewer' },
      }),
    ).rejects.toBeInstanceOf(FevexRunError);

    let secondPause!: RunPausedError;
    await first.runAgent('assistant', { input: 'two' }).catch((error) => {
      secondPause = error;
    });
    expect(await makeApp().cancelRun(secondPause.runId)).toBe(true);
    expect((await first.getRun(secondPause.runId))?.status).toBe('cancelled');
    expect((await first.listEvents(secondPause.runId)).at(-1)?.type).toBe('run.cancelled');
  });

  test('applies policies before credentials and retries keyed tools safely', async () => {
    const order: string[] = [];
    const keys: string[] = [];
    let attempts = 0;
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            return input.messages.some(({ role }) => role === 'tool')
              ? { output: 'done' }
              : { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      policies: [
        {
          name: 'allow',
          async authorize() {
            order.push('policy');
            return 'allow' as const;
          },
        },
      ],
      credentialStore: {
        async resolve({ name }) {
          order.push(`credential:${name}`);
          return 'top-secret';
        },
      },
      tools: [
        defineTool({
          name: 'lookup',
          idempotency: 'keyed',
          retry: { maxAttempts: 2, backoffMs: 0 },
          credentials: ['api-key'],
          async execute(_input, context) {
            attempts += 1;
            keys.push(context.idempotencyKey);
            const secret = await context.getCredential('api-key');
            if (attempts === 1) throw new Error(`provider leaked ${secret}`);
            return 'found';
          },
        }),
      ],
    });
    const result = await app.runAgent('assistant', { input: 'hello' });
    expect(result.output).toBe('done');
    expect(attempts).toBe(2);
    expect(new Set(keys).size).toBe(1);
    expect(order[0]).toBe('policy');
    expect(
      (await app.listEvents(result.runId)).find(({ type }) => type === 'tool.retrying')?.payload,
    ).toMatchObject({ error: 'provider leaked [REDACTED]' });
  });

  test('reuses a durable completed tool execution after redelivery', async () => {
    const store = new InMemoryRunStore();
    let executions = 0;
    const makeApp = () =>
      createFevex({
        models: {
          default: {
            stream: streamFrom(async (input) => {
              return input.messages.some(({ role }) => role === 'tool')
                ? { output: 'done' }
                : { toolCalls: [lookupCall] };
            }),
          },
        },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [
          defineTool({
            name: 'lookup',
            approval: 'required',
            idempotency: 'keyed',
            execute() {
              executions += 1;
              return 'executed';
            },
          }),
        ],
        runStore: store,
      });
    const first = makeApp();
    let paused!: RunPausedError;
    await first.runAgent('assistant', { input: 'hello' }).catch((error) => {
      paused = error;
    });
    const run = (await store.getRun(paused.runId))!;
    const checkpoint = (await store.getCheckpoint(paused.runId))!;
    const pending = checkpoint.pendingTools[checkpoint.pendingIndex]!;
    expect(
      await store.commitExecution({
        expectedRevision: run.revision,
        run,
        toolExecution: {
          runId: run.id,
          toolCallId: pending.call.id,
          toolName: pending.call.name,
          input: pending.input,
          status: 'completed',
          attempt: 1,
          idempotencyKey: pending.idempotencyKey,
          output: 'already-done',
          updatedAt: new Date().toISOString(),
        },
      }),
    ).toBe(true);

    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const second = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input: ModelInput) => {
            return input.messages.some(({ role }) => role === 'tool')
              ? { output: 'done' }
              : { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          approval: 'required',
          idempotency: 'keyed',
          execute() {
            executions += 1;
            return 'executed';
          },
        }),
      ],
      runStore: store,
      onEvent(event) {
        if (event.runId === run.id && event.type === 'run.completed') finish();
      },
    });
    const approval = paused.pause.type === 'approval' ? paused.pause.approval : undefined;
    await second.resumeRun(run.id, {
      type: 'approval',
      approvalId: approval!.id,
      decision: 'approve',
      actor: { id: 'reviewer' },
    });
    await completed;
    expect(executions).toBe(0);
    expect((await second.getRun(run.id))?.status).toBe('completed');
  });

  test('runs a durable team with parallel delegations and a traced handoff', async () => {
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            const role = input.messages[0]!.content;
            if (role === 'planner') return { output: 'plan' };
            if (role === 'researcher') return { output: 'research' };
            if (role === 'coder') return { output: 'code' };
            return { output: 'approved' };
          }),
        },
      },
      agents: [
        agent('planner', { instructions: 'planner' }),
        agent('researcher', { instructions: 'researcher' }),
        agent('coder', { instructions: 'coder' }),
        agent('reviewer', { instructions: 'reviewer' }),
      ],
      teams: [
        defineTeam({
          name: 'software-team',
          supervisor: 'planner',
          members: [
            { agent: 'researcher', role: 'research' },
            { agent: 'coder', role: 'implementation' },
            { agent: 'reviewer', role: 'review' },
          ],
          limits: { maxDelegations: 4, maxParallel: 2 },
          async run(team, input) {
            const plan = await team.delegate<string, string>('plan', {
              agent: 'planner',
              task: input as string,
              expectedOutput: 'Implementation plan',
            });
            const work = await team.parallel('work', {
              research: () =>
                team.delegate<string, string>('research', {
                  agent: 'researcher',
                  task: plan.output,
                }),
              implementation: () =>
                team.delegate<string, string>('implementation', {
                  agent: 'coder',
                  task: plan.output,
                }),
            });
            return (
              await team.handoff<
                { research: string; implementation: string },
                string
              >('review', {
                from: 'coder',
                to: 'reviewer',
                reason: 'Final review',
                task: {
                  research: work.research.output,
                  implementation: work.implementation.output,
                },
              })
            ).output;
          },
        }),
      ],
    });

    const result = await app.runTeam<string, string>('software-team', {
      input: 'Build it',
    });
    expect(result.output).toBe('approved');
    expect(await app.getTeamRun(result.runId)).toMatchObject({
      kind: 'team',
      teamName: 'software-team',
      status: 'completed',
    });

    const events = await app.listEvents(result.runId);
    expect(events.some(({ type }) => type.startsWith('workflow.'))).toBe(false);
    expect(events.map(({ type }) => type)).toContain('team.merge.completed');
    expect(events.filter(({ type }) => type === 'team.agent.assigned')).toHaveLength(4);
    expect(events.find(({ type }) => type === 'team.handoff.created')).toMatchObject({
      payload: {
        delegationId: 'review',
        from: 'coder',
        to: 'reviewer',
        reason: 'Final review',
      },
    });
    expect(events.find(({ type }) => type === 'model.output.delta')).toMatchObject({
      payload: {
        teamDelegationId: 'plan',
        teamAgentName: 'planner',
      },
    });
  });

  test('validates team membership and operational limits', async () => {
    expect(
      getConfigurationError({
        models: { default: modelWithOutput('ok') },
        agents: [agent('planner')],
        teams: [
          defineTeam({
            name: 'invalid-team',
            supervisor: 'missing',
            members: [],
            run() {},
          }),
        ],
      }).code,
    ).toBe('INVALID_TEAM');

    const app = createFevex({
      models: { default: modelWithOutput('ok') },
      agents: [agent('planner'), agent('worker')],
      teams: [
        defineTeam({
          name: 'limited-team',
          supervisor: 'planner',
          members: [{ agent: 'worker', role: 'work' }],
          limits: { maxDelegations: 1, maxParallel: 1 },
          async run(team, input) {
            await team.delegate('first', { agent: 'worker', task: input });
            return team.delegate('second', { agent: 'worker', task: input });
          },
        }),
      ],
    });

    await expect(app.runTeam('limited-team', { input: 'work' })).rejects.toThrow(
      'exceeded maxDelegations limit of 1',
    );
  });

  test('resumes supervisor, parallel work and review without repeating delegations', async () => {
    const store = new InMemoryRunStore();
    const modelCalls = new Map<string, number>();
    let toolExecutions = 0;
    const team = defineTeam({
      name: 'approval-team',
      supervisor: 'planner',
      members: [
        { agent: 'researcher', role: 'research' },
        { agent: 'coder', role: 'implementation' },
        { agent: 'reviewer', role: 'review' },
      ],
      limits: { maxDelegations: 4, maxParallel: 2 },
      async run(step, input) {
        const plan = await step.delegate<string, string>('plan', {
          agent: 'planner',
          task: input as string,
        });
        const work = await step.parallel('work', {
          research: () =>
            step.delegate<string, string>('research', {
              agent: 'researcher',
              task: plan.output,
            }),
          implementation: () =>
            step.delegate<string, string>('implementation', {
              agent: 'coder',
              task: plan.output,
            }),
        });
        return (
          await step.handoff('review', {
            from: 'coder',
            to: 'reviewer',
            reason: 'Final review',
            task: {
              research: work.research.output,
              implementation: work.implementation.output,
            },
          })
        ).output;
      },
    });
    const makeApp = (onEvent?: (event: AgentEvent) => void) =>
      createFevex({
        models: {
          default: {
            stateCodec: {
              serialize(state) {
                return structuredClone(state) as JsonObject;
              },
              restore(state) {
                return structuredClone(state);
              },
            },
            stream: streamFrom(async (input) => {
              const role = input.messages[0]!.content;
              modelCalls.set(role, (modelCalls.get(role) ?? 0) + 1);
              if (role !== 'reviewer') return { output: `${role}-done` };
              return input.providerState === undefined
                ? { toolCalls: [lookupCall], providerState: { turn: 1 } }
                : { output: 'approved' };
            }),
          },
        },
        agents: [
          agent('planner', { instructions: 'planner' }),
          agent('researcher', { instructions: 'researcher' }),
          agent('coder', { instructions: 'coder' }),
          agent('reviewer', { instructions: 'reviewer', tools: ['lookup'] }),
        ],
        tools: [
          defineTool({
            name: 'lookup',
            approval: 'required',
            risk: 'write',
            execute() {
              toolExecutions += 1;
              return 'ok';
            },
          }),
        ],
        teams: [team],
        runStore: store,
        ...(onEvent ? { onEvent } : {}),
      });

    let paused!: RunPausedError;
    await makeApp().runTeam('approval-team', { input: 'build' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect(paused.pause.type).toBe('workflow_child');
    const childPause = paused.pause.type === 'workflow_child' ? paused.pause.childPause : undefined;
    const approvalId = childPause?.type === 'approval' ? childPause.approval.id : '';

    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await makeApp((event) => {
      if (event.runId === paused.runId && event.type === 'team.run.completed') finish();
    }).resumeRun(paused.runId, {
      type: 'approval',
      approvalId,
      decision: 'approve',
      actor: { id: 'operator' },
    });
    await completed;

    expect(Object.fromEntries(modelCalls)).toEqual({
      planner: 1,
      researcher: 1,
      coder: 1,
      reviewer: 2,
    });
    expect(toolExecutions).toBe(1);
    const events = await store.listEvents(paused.runId);
    expect(events.filter(({ type }) => type === 'team.agent.assigned')).toHaveLength(4);
    expect(events.filter(({ type }) => type === 'team.task.completed')).toHaveLength(4);
    expect(events.filter(({ type }) => type === 'team.merge.completed')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'team.handoff.created')).toHaveLength(1);
    expect(events.map(({ type }) => type)).toContain('team.run.resumed');
    expect(await store.getRun(paused.runId)).toMatchObject({
      kind: 'team',
      status: 'completed',
      output: 'approved',
    });
  });

  test('streams and cancels team runs through the shared runtime controls', async () => {
    const team = defineTeam({
      name: 'single-team',
      supervisor: 'worker',
      members: [],
      async run(step, input) {
        return (await step.delegate('work', { agent: 'worker', task: input })).output;
      },
    });
    const completedApp = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('worker')],
      teams: [team],
    });
    const streamed: AgentEvent[] = [];
    for await (const event of completedApp.streamTeam('single-team', { input: 'go' })) {
      streamed.push(event);
    }
    expect(streamed.at(0)?.type).toBe('team.run.started');
    expect(streamed.at(-1)?.type).toBe('team.run.completed');

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runningApp = createFevex({
      models: {
        default: {
          async *stream(input) {
            markStarted();
            await new Promise<void>((resolve) => {
              input.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        },
      },
      agents: [agent('worker')],
      teams: [team],
    });
    const run = await runningApp.startTeam('single-team', { input: 'wait' });
    await started;
    expect(await runningApp.cancelRun(run.id)).toBe(true);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await runningApp.getTeamRun(run.id))?.status !== 'running') break;
      await Bun.sleep(2);
    }
    expect(await runningApp.getTeamRun(run.id)).toMatchObject({ status: 'cancelled' });
    expect((await runningApp.listEvents(run.id)).at(-1)?.type).toBe(
      'team.run.cancelled',
    );
  });

  test('recovers a running team child without repeating its delegation', async () => {
    class CrashableStore extends InMemoryRunStore {
      readonly leaseOwners = new Map<string, string>();

      override async createExecution(
        input: Parameters<InMemoryRunStore['createExecution']>[0],
      ): Promise<boolean> {
        this.leaseOwners.set(input.run.id, input.lease.ownerId);
        return super.createExecution(input);
      }
    }
    const store = new CrashableStore();
    let releaseCrashedChild!: () => void;
    let markChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    const team = defineTeam({
      name: 'recover-team',
      version: '1',
      supervisor: 'worker',
      members: [],
      async run(step, input) {
        return (await step.delegate('only-child', { agent: 'worker', task: input })).output;
      },
    });
    const crashedRuntime = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            markChildStarted();
            await new Promise<void>((resolve) => {
              releaseCrashedChild = resolve;
            });
            return { output: 'stale' };
          }),
        },
      },
      agents: [agent('worker')],
      teams: [team],
      runStore: store,
    });
    const parent = await crashedRuntime.startTeam('recover-team', { input: 'go' });
    await childStarted;
    const checkpoint = await store.getCheckpoint<any>(parent.id);
    const childRunId = checkpoint?.steps['only-child'].childRunId as string;
    await store.releaseLease(parent.id, store.leaseOwners.get(parent.id)!);
    await store.releaseLease(childRunId, store.leaseOwners.get(childRunId)!);

    const recoveredRuntime = createFevex({
      models: { default: modelWithOutput('recovered') },
      agents: [agent('worker')],
      teams: [team],
      runStore: store,
    });
    await recoveredRuntime.recoverRun(parent.id, { actor: { id: 'team-worker' } });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await store.getRun(parent.id))?.status !== 'running') break;
      await Bun.sleep(2);
    }

    expect(await store.getRun(parent.id)).toMatchObject({
      kind: 'team',
      status: 'completed',
      output: 'recovered',
    });
    const events = await store.listEvents(parent.id);
    expect(events.filter(({ type }) => type === 'team.agent.assigned')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'team.task.completed')).toHaveLength(1);
    expect(events.map(({ type }) => type)).toContain('team.run.recovered');
    releaseCrashedChild();
    await Bun.sleep(2);
  });

  test('runs workflows with conditional agent steps and parallel fan-out', async () => {
    const calls: string[] = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            const role = input.messages[0]!.content;
            calls.push(role);
            if (role === 'triage') return { output: { kind: 'support' } };
            if (role === 'billing') return { output: 'billing' };
            if (role === 'docs') return { output: 'docs-result' };
            if (role === 'account') return { output: 'account-result' };
            return { output: { answer: 'docs-result/account-result' } };
          }),
        },
      },
      agents: [
        agent('triage', { instructions: 'triage' }),
        agent('billing', { instructions: 'billing' }),
        agent('docs', { instructions: 'docs' }),
        agent('account', { instructions: 'account' }),
        agent('answer', { instructions: 'answer' }),
      ],
      workflows: [
        defineWorkflow({
          name: 'support-flow',
          async run(step, input) {
            const triage = await step.agent<{ question: string }, { kind: string }>(
              'triage',
              'triage',
              { input: input as { question: string } },
            );
            if (triage.output.kind === 'billing') {
              return (await step.agent('billing', 'billing', { input })).output;
            }
            const research = await step.parallel('research', {
              docs: () => step.agent('docs', 'docs', { input }),
              account: () => step.agent('account', 'account', { input }),
            });
            return (
              await step.agent('answer', 'answer', {
                input: {
                  question: input,
                  docs: research.docs.output,
                  account: research.account.output,
                },
              })
            ).output;
          },
        }),
      ],
    });

    const result = await app.runWorkflow<{ question: string }, { answer: string }>(
      'support-flow',
      { input: { question: 'help' } },
    );

    expect(result.output).toEqual({ answer: 'docs-result/account-result' });
    expect(calls).toEqual(['triage', 'docs', 'account', 'answer']);
    expect((await app.listEvents(result.runId)).map(({ type }) => type)).toEqual([
      'workflow.run.started',
      'workflow.step.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'workflow.step.completed',
      'workflow.step.started',
      'workflow.step.started',
      'workflow.step.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'workflow.step.completed',
      'model.started',
      'model.output.delta',
      'model.completed',
      'workflow.step.completed',
      'workflow.step.completed',
      'workflow.step.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'workflow.step.completed',
      'workflow.run.completed',
    ]);
    await expect(app.runWorkflow('missing-flow', { input: 'hello' })).rejects.toThrow(
      'Workflow "missing-flow" is not registered',
    );
    await expect(
      app.runWorkflow('support-flow', { input: { question: 'hello' }, context: {} }),
    ).resolves.toMatchObject({ output: { answer: 'docs-result/account-result' } });
  });

  test('pauses and resumes durable workflows when a child agent needs approval', async () => {
    const store = new InMemoryRunStore();
    let executions = 0;
    const workflow = defineWorkflow({
      name: 'approval-flow',
      async run(step, input) {
        return (await step.agent('approve', 'assistant', { input })).output;
      },
    });
    const configuredModel = (): ModelGateway => ({
      stateCodec: {
        serialize(state) {
          return structuredClone(state) as JsonObject;
        },
        restore(state) {
          return structuredClone(state);
        },
      },
      stream: streamFrom(async (input) => {
        if (input.providerState === undefined) {
          return { toolCalls: [lookupCall], providerState: { turn: 1 } };
        }
        return { output: 'approved' };
      }),
    });
    const configuredTool = () =>
      defineTool({
        name: 'lookup',
        risk: 'write',
        approval: 'required',
        idempotency: 'keyed',
        execute() {
          executions += 1;
          return 'found';
        },
      });
    const makeApp = (onEvent?: (event: AgentEvent) => void) =>
      createFevex({
        models: { default: configuredModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [configuredTool()],
        workflows: [workflow],
        runStore: store,
        ...(onEvent ? { onEvent } : {}),
      });

    const first = makeApp();
    let paused!: RunPausedError;
    await first.runWorkflow('approval-flow', { input: 'hello' }).catch((error) => {
      expect(error).toBeInstanceOf(RunPausedError);
      paused = error;
    });
    expect(paused.pause.type).toBe('workflow_child');
    expect(executions).toBe(0);

    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const second = makeApp((event) => {
      if (event.runId === paused.runId && event.type === 'workflow.run.completed') complete();
    });
    const childPause = paused.pause.type === 'workflow_child' ? paused.pause.childPause : undefined;
    const approval = childPause?.type === 'approval' ? childPause.approval : undefined;
    await second.resumeRun(paused.runId, {
      type: 'approval',
      approvalId: approval!.id,
      decision: 'approve',
      actor: { id: 'reviewer-1' },
    });
    await completed;

    expect(await second.getRun(paused.runId)).toMatchObject({
      kind: 'workflow',
      status: 'completed',
      output: 'approved',
    });
    expect(executions).toBe(1);
    expect((await second.listEvents(paused.runId)).map(({ type }) => type)).toEqual([
      'workflow.run.started',
      'workflow.step.started',
      'model.started',
      'model.completed',
      'approval.requested',
      'workflow.run.paused',
      'workflow.run.resumed',
      'workflow.step.completed',
      'workflow.run.completed',
    ]);
  });

  test('cancels a paused workflow child before cancelling its parent', async () => {
    const store = new InMemoryRunStore();
    const workflow = defineWorkflow({
      name: 'cancel-child-flow',
      async run(step, input) {
        return (await step.agent('approval', 'assistant', { input })).output;
      },
    });
    const makeApp = () =>
      createFevex({
        models: {
          default: {
            stateCodec: {
              serialize: (state) => state as JsonObject,
              restore: (state) => state,
            },
            stream: streamFrom(async (input) =>
              input.providerState
                ? { output: 'done' }
                : { toolCalls: [lookupCall], providerState: { turn: 1 } },
            ),
          },
        },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [
          defineTool({
            name: 'lookup',
            risk: 'write',
            approval: 'required',
            idempotency: 'keyed',
            execute: () => 'done',
          }),
        ],
        workflows: [workflow],
        runStore: store,
      });

    let paused!: RunPausedError;
    await makeApp().runWorkflow('cancel-child-flow', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    const checkpoint = await store.getCheckpoint<any>(paused.runId);
    const childRunId = checkpoint?.steps.approval.childRunId as string;

    expect(await makeApp().cancelRun(paused.runId)).toBe(true);
    expect(await store.getRun(childRunId)).toMatchObject({ status: 'cancelled' });
    expect(await store.getRun(paused.runId)).toMatchObject({ status: 'cancelled' });
    expect((await store.listEvents(childRunId)).at(-1)?.type).toBe('run.cancelled');
    expect((await store.listEvents(paused.runId)).at(-1)?.type).toBe(
      'workflow.run.cancelled',
    );
  });

  test('settles parallel work and reports multiple failures in declaration order', async () => {
    const settled: string[] = [];
    const app = createFevex({
      models: { default: modelWithOutput('unused') },
      agents: [agent('assistant')],
      workflows: [
        defineWorkflow({
          name: 'parallel-failures',
          async run(step) {
            await step.parallel('fanout', {
              first: async () => {
                await Bun.sleep(4);
                settled.push('first');
                throw new Error('first failed');
              },
              second: async () => {
                settled.push('second');
                throw new Error('second failed');
              },
            });
            return 'unreachable';
          },
        }),
      ],
    });

    let failure!: AggregateError;
    await app.runWorkflow('parallel-failures', { input: 'go' }).catch((error) => {
      failure = error as AggregateError;
    });
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toBe('Workflow parallel step "fanout" failed');
    expect(failure.errors.map((error) => (error as Error).message)).toEqual([
      'first failed',
      'second failed',
    ]);
    expect(settled).toEqual(['second', 'first']);
  });

  test('compensates completed workflow steps in reverse order when a workflow fails', async () => {
    const compensated: string[] = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => ({ output: input.messages[0]!.content })),
        },
      },
      agents: [agent('first', { instructions: 'first' }), agent('second', { instructions: 'second' })],
      workflows: [
        defineWorkflow({
          name: 'compensating-flow',
          async run(step, input) {
            await step.agent('first', 'first', { input }, {
              compensate(result) {
                compensated.push(`first:${result.output}`);
              },
            });
            await step.agent('second', 'second', { input }, {
              compensate(result) {
                compensated.push(`second:${result.output}`);
              },
            });
            throw new Error('workflow failed');
          },
        }),
      ],
    });

    await expect(app.runWorkflow('compensating-flow', { input: 'go' })).rejects.toThrow(
      'workflow failed',
    );

    expect(compensated).toEqual(['second:second', 'first:first']);
  });

  test('does not repeat compensated steps after replaying a paused workflow', async () => {
    const store = new InMemoryRunStore();
    const executions: string[] = [];
    const workflow = defineWorkflow({
      name: 'replay-compensation-flow',
      events: { release: {} },
      async run(step, input) {
        await step.agent('write', 'writer', { input }, {
          compensate(result) {
            executions.push(`compensate:${result.output}`);
          },
        });
        await step.waitForEvent('release', 'release');
        throw new Error('after replay');
      },
    });
    const makeApp = () =>
      createFevex({
        models: {
          default: {
            stream: streamFrom(async () => {
              executions.push('write');
              return { output: 'written' };
            }),
          },
        },
        agents: [agent('writer')],
        workflows: [workflow],
        runStore: store,
      });

    let paused!: RunPausedError;
    await makeApp().runWorkflow('replay-compensation-flow', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect(paused).toBeInstanceOf(RunPausedError);

    await makeApp().resumeRun(paused.runId, { type: 'event', eventName: 'release' });
    await Bun.sleep(5);

    expect(executions).toEqual(['write', 'compensate:written']);
    expect(await store.getRun(paused.runId)).toMatchObject({ status: 'failed' });
  });

  test('marks workflow failed when compensation fails', async () => {
    const store = new InMemoryRunStore();
    const events: AgentEvent[] = [];
    const app = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('writer')],
      workflows: [
        defineWorkflow({
          name: 'failed-compensation-flow',
          async run(step, input) {
            await step.agent('write', 'writer', { input }, {
              compensate() {
                throw new Error('undo failed');
              },
            });
            throw new Error('main failed');
          },
        }),
      ],
      runStore: store,
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(app.runWorkflow('failed-compensation-flow', { input: 'go' })).rejects.toThrow(
      'Workflow failed: main failed; compensation failed: undo failed',
    );

    const failed = events.find(({ type }) => type === 'workflow.run.failed')!;
    expect(await store.getRun(failed.runId)).toMatchObject({
      status: 'failed',
      error: 'Workflow failed: main failed; compensation failed: undo failed',
    });
    expect(events.map(({ type }) => type)).toContain('workflow.compensation.failed');
  });

  test('pauses a workflow until a timer is explicitly resumed after it elapses', async () => {
    const store = new InMemoryRunStore();
    const resumeAt = new Date(Date.now() + 20).toISOString();
    const workflow = defineWorkflow({
      name: 'timer-flow',
      async run(step) {
        await step.waitUntil('timer', resumeAt);
        return 'ready';
      },
    });
    const makeApp = (onEvent?: (event: AgentEvent) => void) =>
      createFevex({
        models: { default: modelWithOutput('unused') },
        agents: [agent('assistant')],
        workflows: [workflow],
        runStore: store,
        ...(onEvent ? { onEvent } : {}),
      });

    let paused!: RunPausedError;
    await makeApp().runWorkflow('timer-flow', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect(paused.pause).toMatchObject({ type: 'workflow_timer', resumeAt });
    await expect(makeApp().resumeRun(paused.runId, { type: 'timer' })).rejects.toMatchObject({
      code: 'RUN_NOT_RESUMABLE',
    });

    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await Bun.sleep(25);
    await makeApp((event) => {
      if (event.type === 'workflow.run.completed') complete();
    }).resumeRun(paused.runId, { type: 'timer' });
    await completed;

    expect(await store.getRun(paused.runId)).toMatchObject({ status: 'completed', output: 'ready' });
  });

  test('pauses a workflow until the matching external event is resumed', async () => {
    const store = new InMemoryRunStore();
    const workflow = defineWorkflow({
      name: 'event-flow',
      events: { approved: {} },
      async run(step) {
        const event = await step.waitForEvent<JsonObject>('approval-event', 'approved');
        return event.payload;
      },
    });
    const makeApp = (onEvent?: (event: AgentEvent) => void) =>
      createFevex({
        models: { default: modelWithOutput('unused') },
        agents: [agent('assistant')],
        workflows: [workflow],
        runStore: store,
        ...(onEvent ? { onEvent } : {}),
      });

    let paused!: RunPausedError;
    await makeApp().runWorkflow('event-flow', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect(paused.pause).toMatchObject({ type: 'workflow_event', eventName: 'approved' });
    await expect(
      makeApp().resumeRun(paused.runId, { type: 'event', eventName: 'wrong' }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_RESUMABLE' });

    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await makeApp((event) => {
      if (event.type === 'workflow.run.completed') complete();
    }).resumeRun(paused.runId, {
      type: 'event',
      eventName: 'approved',
      payload: { approved: true },
    });
    await completed;

    expect(await store.getRun(paused.runId)).toMatchObject({
      status: 'completed',
      output: { approved: true },
    });
  });

  test('transforms workflow input and persists an audited, schema-validated event', async () => {
    const store = new InMemoryRunStore();
    const inputSchema = schema<{ value: string }>(
      (value) => ({ value: { value: String(value).trim().toUpperCase() } }),
      { type: 'string' },
    );
    const eventSchema = schema<{ approved: true }>(
      (value) =>
        (value as { decision?: unknown })?.decision === 'yes'
          ? { value: { approved: true as const } }
          : { issues: [{ message: 'decision must be yes' }] },
      {
        type: 'object',
        properties: { decision: { const: 'yes' } },
        required: ['decision'],
      },
    );
    const outputSchema = schema<string>(
      (value) => {
        const result = value as {
          input: { value: string };
          event: { payload?: { approved: true }; actor?: { id: string }; receivedAt: string };
        };
        return {
          value:
            `${result.input.value}:${result.event.payload?.approved}:` +
            `${result.event.actor?.id}:${result.event.receivedAt}`,
        };
      },
      { type: 'string' },
    );
    const workflow = defineWorkflow({
      name: 'audited-event-flow',
      inputSchema,
      outputSchema,
      events: {
        approved: { payloadSchema: eventSchema, requireActor: true },
      },
      async run(step, input: { value: string }) {
        const event = await step.waitForEvent<{ approved: true }>('approval', 'approved');
        return { input, event };
      },
    });
    const makeApp = () =>
      createFevex({
        models: { default: modelWithOutput('unused') },
        agents: [agent('assistant')],
        workflows: [workflow],
        runStore: store,
      });

    let paused!: RunPausedError;
    await makeApp().runWorkflow('audited-event-flow', { input: '  hello  ' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect((await store.getCheckpoint<any>(paused.runId))?.input).toEqual({ value: 'HELLO' });

    await expect(
      makeApp().resumeRun(paused.runId, {
        type: 'event',
        eventName: 'approved',
        payload: { decision: 'yes' },
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(
      makeApp().resumeRun(paused.runId, {
        type: 'event',
        eventName: 'approved',
        payload: { decision: 'no' },
        actor: { id: 'reviewer' },
      }),
    ).rejects.toThrow('decision must be yes');
    expect(await store.getRun(paused.runId)).toMatchObject({ status: 'paused' });

    await makeApp().resumeRun(paused.runId, {
      type: 'event',
      eventName: 'approved',
      payload: { decision: 'yes' },
      actor: { id: 'reviewer' },
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await store.getRun(paused.runId))?.status !== 'running') break;
      await Bun.sleep(2);
    }
    const completed = await store.getRun(paused.runId);
    expect(completed).toMatchObject({ status: 'completed' });
    expect(String(completed?.output)).toStartWith('HELLO:true:reviewer:');
    expect(
      (await store.listEvents(paused.runId)).find(
        ({ type }) => type === 'workflow.wait.completed',
      )?.payload,
    ).toMatchObject({
      payload: { approved: true },
      actorId: 'reviewer',
    });
  });

  test('fails a resumed workflow when its definition output schema rejects the result', async () => {
    const store = new InMemoryRunStore();
    const workflow = defineWorkflow({
      name: 'invalid-resumed-output',
      outputSchema: schema(
        () => ({ issues: [{ message: 'final output is invalid' }] }),
        { type: 'string' },
      ),
      events: { release: {} },
      async run(step) {
        await step.waitForEvent('release', 'release');
        return 'invalid';
      },
    });
    const makeApp = () =>
      createFevex({
        models: { default: modelWithOutput('unused') },
        agents: [agent('assistant')],
        workflows: [workflow],
        runStore: store,
      });
    let paused!: RunPausedError;
    await makeApp().runWorkflow('invalid-resumed-output', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    await makeApp().resumeRun(paused.runId, { type: 'event', eventName: 'release' });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await store.getRun(paused.runId))?.status !== 'running') break;
      await Bun.sleep(2);
    }
    expect(await store.getRun(paused.runId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('final output is invalid'),
    });
  });

  test('inherits workflow context while preventing child actor impersonation', async () => {
    const seen: Array<{ source: string; context: unknown }> = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) =>
            input.messages.some(({ role }) => role === 'tool')
              ? { output: 'done' }
              : { toolCalls: [{ id: 'context-call', name: 'inspect', input: {} }] },
          ),
        },
      },
      contextProviders: [
        {
          name: 'tenant',
          async read(input) {
            seen.push({ source: 'provider', context: input.context });
            return [];
          },
        },
      ],
      policies: [
        {
          name: 'context-policy',
          authorize(input) {
            seen.push({ source: 'policy', context: input.context });
            return 'allow';
          },
        },
      ],
      tools: [
        defineTool({
          name: 'inspect',
          execute(_input, input) {
            seen.push({ source: 'tool', context: input.context });
            return 'ok';
          },
        }),
      ],
      agents: [agent('worker', { context: ['tenant'], tools: ['inspect'] })],
      workflows: [
        defineWorkflow({
          name: 'context-flow',
          async run(step, input) {
            return (
              await step.agent('inspect', 'worker', {
                input,
                context: {
                  namespace: 'child',
                  actor: { id: 'impersonator' },
                  attributes: { child: true, shared: 'child' },
                  prompt: { child: true },
                },
              })
            ).output;
          },
        }),
      ],
    });

    await app.runWorkflow('context-flow', {
      input: 'go',
      context: {
        namespace: 'parent',
        actor: { id: 'authenticated' },
        attributes: { parent: true, shared: 'parent' },
        prompt: { parent: true },
      },
    });
    expect(seen.map(({ source }) => source)).toEqual(['provider', 'policy', 'tool']);
    for (const item of seen) {
      expect(item.context).toEqual({
        namespace: 'child',
        actor: { id: 'authenticated' },
        attributes: { parent: true, shared: 'child', child: true },
        prompt: { parent: true, child: true },
      });
    }
  });

  test('recovers an orphaned agent checkpoint with persisted limits and usage', async () => {
    class CrashableStore extends InMemoryRunStore {
      leaseOwner?: string;

      override async createExecution(
        input: Parameters<InMemoryRunStore['createExecution']>[0],
      ): Promise<boolean> {
        this.leaseOwner = input.lease.ownerId;
        return super.createExecution(input);
      }
    }
    const store = new CrashableStore();
    let releaseCrashedModel!: () => void;
    let markCrashedModelStarted!: () => void;
    const crashedModelStarted = new Promise<void>((resolve) => {
      markCrashedModelStarted = resolve;
    });
    const crashedRuntime = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            markCrashedModelStarted();
            await new Promise<void>((resolve) => {
              releaseCrashedModel = resolve;
            });
            return { output: 'stale' };
          }),
        },
      },
      agents: [agent('recoverable')],
      runStore: store,
    });
    const run = await crashedRuntime.startAgent('recoverable', {
      input: 'go',
      limits: { maxOutputTokens: 3 },
    });
    await crashedModelStarted;
    await store.releaseLease(run.id, store.leaseOwner!);

    let recoveredLimit: number | undefined;
    const recoveredRuntime = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            recoveredLimit = input.maxOutputTokens;
            return {
              output: 'recovered',
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            };
          }),
        },
      },
      agents: [agent('recoverable')],
      runStore: store,
    });
    await recoveredRuntime.recoverRun(run.id, { actor: { id: 'worker-2' } });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await store.getRun(run.id))?.status !== 'running') break;
      await Bun.sleep(2);
    }
    releaseCrashedModel();
    await Bun.sleep(2);

    expect(recoveredLimit).toBe(3);
    expect(await store.getRun(run.id)).toMatchObject({
      status: 'completed',
      output: 'recovered',
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
    expect((await store.listEvents(run.id)).map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'run.recovered',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ]);
    await expect(
      recoveredRuntime.recoverRun(run.id, { actor: { id: 'worker-3' } }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_RECOVERABLE' });
  });

  test('recovers keyed tools with the same key and pauses uncertain non-keyed tools', async () => {
    class CrashableStore extends InMemoryRunStore {
      leaseOwner?: string;

      override async createExecution(
        input: Parameters<InMemoryRunStore['createExecution']>[0],
      ): Promise<boolean> {
        this.leaseOwner = input.lease.ownerId;
        return super.createExecution(input);
      }
    }
    const exercise = async (idempotency: 'keyed' | 'none') => {
      const store = new CrashableStore();
      const keys: string[] = [];
      let executions = 0;
      let releaseFirst!: () => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const model: ModelGateway = {
        stream: streamFrom(async (input) =>
          input.messages.some(({ role }) => role === 'tool')
            ? { output: 'done' }
            : { toolCalls: [{ id: 'crash-tool', name: 'effect', input: {} }] },
        ),
      };
      const tool = () =>
        defineTool({
          name: 'effect',
          idempotency,
          async execute(_input, context) {
            executions += 1;
            keys.push(context.idempotencyKey);
            if (executions === 1) {
              markStarted();
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
              });
            }
            return 'effect';
          },
        });
      const first = createFevex({
        models: { default: model },
        agents: [agent('tool-recovery', { tools: ['effect'] })],
        tools: [tool()],
        runStore: store,
      });
      const run = await first.startAgent('tool-recovery', { input: 'go' });
      await started;
      await store.releaseLease(run.id, store.leaseOwner!);

      const second = createFevex({
        models: { default: model },
        agents: [agent('tool-recovery', { tools: ['effect'] })],
        tools: [tool()],
        runStore: store,
      });
      await second.recoverRun(run.id, { actor: { id: 'recovery-worker' } });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await store.getRun(run.id))?.status !== 'running') break;
        await Bun.sleep(2);
      }

      if (idempotency === 'none') {
        const unknown = await store.getRun(run.id);
        expect(unknown).toMatchObject({
          status: 'paused',
          pause: { type: 'tool_execution_unknown', toolCallId: 'crash-tool' },
        });
        expect(executions).toBe(1);
        await second.resumeRun(run.id, {
          type: 'tool_execution',
          toolCallId: 'crash-tool',
          decision: 'retry',
          actor: { id: 'operator' },
        });
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if ((await store.getRun(run.id))?.status !== 'running') break;
          await Bun.sleep(2);
        }
      }

      expect(await store.getRun(run.id)).toMatchObject({
        status: 'completed',
        output: 'done',
      });
      expect(executions).toBe(2);
      expect(new Set(keys).size).toBe(1);
      releaseFirst();
      await Bun.sleep(2);
    };

    await exercise('keyed');
    await exercise('none');
  });

  test('recovers a running workflow child without replacing or repeating its step', async () => {
    class CrashableStore extends InMemoryRunStore {
      readonly leaseOwners = new Map<string, string>();

      override async createExecution(
        input: Parameters<InMemoryRunStore['createExecution']>[0],
      ): Promise<boolean> {
        this.leaseOwners.set(input.run.id, input.lease.ownerId);
        return super.createExecution(input);
      }
    }
    const store = new CrashableStore();
    let releaseCrashedChild!: () => void;
    let markChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    const workflow = defineWorkflow({
      name: 'recover-child-flow',
      version: '1',
      async run(step, input) {
        return (await step.agent('only-child', 'worker', { input })).output;
      },
    });
    const crashedRuntime = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            markChildStarted();
            await new Promise<void>((resolve) => {
              releaseCrashedChild = resolve;
            });
            return { output: 'stale' };
          }),
        },
      },
      agents: [agent('worker')],
      workflows: [workflow],
      runStore: store,
    });
    const parent = await crashedRuntime.startWorkflow('recover-child-flow', { input: 'go' });
    await childStarted;
    const checkpoint = await store.getCheckpoint<any>(parent.id);
    const childRunId = checkpoint?.steps['only-child'].childRunId as string;
    await store.releaseLease(parent.id, store.leaseOwners.get(parent.id)!);
    await store.releaseLease(childRunId, store.leaseOwners.get(childRunId)!);

    const recoveredRuntime = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => ({
            output: 'recovered-child',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          })),
        },
      },
      agents: [agent('worker')],
      workflows: [workflow],
      runStore: store,
    });
    await recoveredRuntime.recoverRun(parent.id, { actor: { id: 'workflow-worker' } });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await store.getRun(parent.id))?.status !== 'running') break;
      await Bun.sleep(2);
    }
    expect(await store.getRun(parent.id)).toMatchObject({
      status: 'completed',
      output: 'recovered-child',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    expect(await store.getRun(childRunId)).toMatchObject({
      status: 'completed',
      output: 'recovered-child',
    });
    const parentEvents = await store.listEvents(parent.id);
    expect(parentEvents.filter(({ type }) => type === 'workflow.step.started')).toHaveLength(1);
    expect(parentEvents.filter(({ type }) => type === 'workflow.step.completed')).toHaveLength(1);
    expect(parentEvents.filter(({ type }) => type === 'workflow.run.completed')).toHaveLength(1);
    expect(parentEvents.map(({ type }) => type)).toContain('workflow.run.recovered');
    releaseCrashedChild();
    await Bun.sleep(2);
  });

  test('rejects legacy checkpoints without inferring missing v2 contracts', async () => {
    class LegacyCheckpointStore extends InMemoryRunStore {
      legacy = false;

      override async getCheckpoint<
        TCheckpoint extends StoredRunCheckpoint = RunCheckpoint,
      >(runId: string): Promise<TCheckpoint | undefined> {
        const checkpoint = await super.getCheckpoint<TCheckpoint>(runId);
        return this.legacy && checkpoint
          ? ({ ...checkpoint, version: 1 } as unknown as TCheckpoint)
          : checkpoint;
      }
    }
    const store = new LegacyCheckpointStore();
    const workflow = defineWorkflow({
      name: 'legacy-flow',
      events: { release: {} },
      async run(step) {
        await step.waitForEvent('release', 'release');
        return 'done';
      },
    });
    const app = createFevex({
      models: { default: modelWithOutput('unused') },
      agents: [agent('assistant')],
      workflows: [workflow],
      runStore: store,
    });
    let paused!: RunPausedError;
    await app.runWorkflow('legacy-flow', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    store.legacy = true;

    await expect(
      app.resumeRun(paused.runId, { type: 'event', eventName: 'release' }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_UNSUPPORTED' });
    expect(await store.getRun(paused.runId)).toMatchObject({ status: 'paused' });
  });

  test('inherits workflow token budget into child agents', async () => {
    const requestedOutputLimits: Array<number | undefined> = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            requestedOutputLimits.push(input.maxOutputTokens);
            return { output: 'ok', usage: { inputTokens: 1, outputTokens: 3 } };
          }),
        },
      },
      agents: [agent('worker')],
      workflows: [
        defineWorkflow({
          name: 'token-budget-flow',
          limits: { maxOutputTokens: 5 },
          async run(step, input) {
            await step.agent('first', 'worker', { input });
            await step.agent('second', 'worker', { input });
            return 'done';
          },
        }),
      ],
    });

    await expect(app.runWorkflow('token-budget-flow', { input: 'go' })).rejects.toThrow(
      'exceeded maxOutputTokens limit of 2',
    );
    expect(requestedOutputLimits).toEqual([5, 2]);
  });

  test('inherits workflow step and tool-call budgets into child agents', async () => {
    const stepBudgetApp = createFevex({
      models: { default: modelWithOutput('ok') },
      agents: [agent('worker')],
      workflows: [
        defineWorkflow({
          name: 'step-budget-flow',
          limits: { maxSteps: 1 },
          async run(step, input) {
            await step.agent('first', 'worker', { input });
            await step.agent('second', 'worker', { input });
            return 'done';
          },
        }),
      ],
    });

    await expect(stepBudgetApp.runWorkflow('step-budget-flow', { input: 'go' })).rejects.toThrow(
      'reached maxSteps limit of 0',
    );

    const toolCall = { id: 'tool-1', name: 'lookup', input: {} };
    const toolBudgetApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) =>
            input.messages.some(({ role }) => role === 'tool')
              ? { output: 'done' }
              : { toolCalls: [toolCall] },
          ),
        },
      },
      agents: [agent('worker', { tools: ['lookup'] })],
      tools: [defineTool({ name: 'lookup', execute: () => 'ok' })],
      workflows: [
        defineWorkflow({
          name: 'tool-budget-flow',
          limits: { maxSteps: 10, maxToolCalls: 1 },
          async run(step, input) {
            await step.agent('first', 'worker', { input });
            await step.agent('second', 'worker', { input });
            return 'done';
          },
        }),
      ],
    });

    await expect(toolBudgetApp.runWorkflow('tool-budget-flow', { input: 'go' })).rejects.toThrow(
      'reached maxToolCalls limit of 0',
    );
  });

  test('adds parallel child usage back into the shared workflow budget', async () => {
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => ({
            output: 'ok',
            usage: { inputTokens: 1, outputTokens: 3 },
          })),
        },
      },
      agents: [agent('worker')],
      workflows: [
        defineWorkflow({
          name: 'parallel-budget-flow',
          limits: { maxOutputTokens: 5 },
          async run(step, input) {
            await step.parallel('parallel', {
              left: () => step.agent('left', 'worker', { input }),
              right: () => step.agent('right', 'worker', { input }),
            });
            return 'done';
          },
        }),
      ],
    });

    await expect(app.runWorkflow('parallel-budget-flow', { input: 'go' })).rejects.toThrow(
      'exceeded maxOutputTokens limit of 5',
    );
  });

  describe('definition guard', () => {
    const approvalModel = (): ModelGateway => ({
      stateCodec: {
        serialize: (state) => structuredClone(state) as JsonObject,
        restore: (state) => structuredClone(state),
      },
      stream: streamFrom(async (input) =>
        input.providerState === undefined
          ? { toolCalls: [lookupCall], providerState: { turn: 1 } }
          : { output: 'approved' },
      ),
    });
    const approvalTool = () =>
      defineTool({
        name: 'lookup',
        risk: 'write',
        approval: 'required',
        idempotency: 'keyed',
        execute: () => 'found',
      });

    const pauseWorkflow = async (
      store: InMemoryRunStore,
      workflow: WorkflowDefinition,
    ): Promise<RunPausedError> => {
      const app = createFevex({
        models: { default: approvalModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [approvalTool()],
        workflows: [workflow],
        runStore: store,
      });
      let paused!: RunPausedError;
      await app.runWorkflow(workflow.name, { input: 'hello' }).catch((error) => {
        paused = error as RunPausedError;
      });
      expect(paused).toBeInstanceOf(RunPausedError);
      return paused;
    };

    const resumeWith = (store: InMemoryRunStore, workflow: WorkflowDefinition) =>
      createFevex({
        models: { default: approvalModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [approvalTool()],
        workflows: [workflow],
        runStore: store,
      });

    const approve = (approvalId: string) =>
      ({
        type: 'approval',
        approvalId,
        decision: 'approve',
        actor: { id: 'reviewer-1' },
      }) as const;

    const approvalIdOf = (paused: RunPausedError): string => {
      const childPause =
        paused.pause.type === 'workflow_child' ? paused.pause.childPause : paused.pause;
      return childPause.type === 'approval' ? childPause.approval.id : '';
    };

    test('resumes a workflow whose run was rewritten but keeps its version', async () => {
      const store = new InMemoryRunStore();
      const paused = await pauseWorkflow(
        store,
        defineWorkflow({
          name: 'rewritten-flow',
          async run(step, input) {
            return (await step.agent('approve', 'assistant', { input })).output;
          },
        }),
      );

      // Same declared version, different source text. This is what a bundler or
      // a minifier produces, and it must not invalidate an in-flight run.
      const rewritten = defineWorkflow({
        name: 'rewritten-flow',
        run: async (s, i) => {
          const result = await s.agent('approve', 'assistant', { input: i });
          return result.output;
        },
      });
      const app = resumeWith(store, rewritten);
      await app.resumeRun(paused.runId, approve(approvalIdOf(paused)));

      await Bun.sleep(5);
      expect(await app.getRun(paused.runId)).toMatchObject({ status: 'completed' });
    });

    test('refuses to resume a workflow after its version changes', async () => {
      const store = new InMemoryRunStore();
      const paused = await pauseWorkflow(
        store,
        defineWorkflow({
          name: 'versioned-flow',
          version: '1',
          async run(step, input) {
            return (await step.agent('approve', 'assistant', { input })).output;
          },
        }),
      );

      const bumped = defineWorkflow({
        name: 'versioned-flow',
        version: '2',
        async run(step, input) {
          return (await step.agent('approve', 'assistant', { input })).output;
        },
      });
      const app = resumeWith(store, bumped);

      await expect(
        app.resumeRun(paused.runId, approve(approvalIdOf(paused))),
      ).rejects.toMatchObject({
        code: 'RUN_DEFINITION_CHANGED',
        message: 'Definition for workflow "versioned-flow" changed',
      });
      expect(await app.getRun(paused.runId)).toMatchObject({ status: 'paused' });
    });

    test('refuses to resume an agent after its instructions change', async () => {
      const store = new InMemoryRunStore();
      const first = createFevex({
        models: { default: approvalModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [approvalTool()],
        runStore: store,
      });
      let paused!: RunPausedError;
      await first.runAgent('assistant', { input: 'hello' }).catch((error) => {
        paused = error as RunPausedError;
      });
      expect(paused).toBeInstanceOf(RunPausedError);

      const second = createFevex({
        models: { default: approvalModel() },
        agents: [
          agent('assistant', { tools: ['lookup'], instructions: 'Answer very differently.' }),
        ],
        tools: [approvalTool()],
        runStore: store,
      });

      await expect(
        second.resumeRun(paused.runId, approve(approvalIdOf(paused))),
      ).rejects.toMatchObject({
        code: 'RUN_DEFINITION_CHANGED',
        message: 'Definition for agent "assistant" changed',
      });
      expect(await second.getRun(paused.runId)).toMatchObject({ status: 'paused' });
    });

    test('refuses to resume an agent after sandbox capabilities change', async () => {
      const store = new InMemoryRunStore();
      const sandbox = {
        async run() {
          return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 0, timedOut: false };
        },
      };
      const sandboxedTool = (command: string) =>
        defineTool({
          name: 'lookup',
          approval: 'required',
          idempotency: 'keyed',
          sandbox: { process: { commands: [command] } },
          execute: () => 'found',
        });
      const first = createFevex({
        models: { default: approvalModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [sandboxedTool('node')],
        sandbox,
        runStore: store,
      });
      let paused!: RunPausedError;
      await first.runAgent('assistant', { input: 'hello' }).catch((error) => {
        paused = error as RunPausedError;
      });
      expect(paused).toBeInstanceOf(RunPausedError);

      const second = createFevex({
        models: { default: approvalModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [sandboxedTool('bun')],
        sandbox,
        runStore: store,
      });

      await expect(
        second.resumeRun(paused.runId, approve(approvalIdOf(paused))),
      ).rejects.toMatchObject({
        code: 'RUN_DEFINITION_CHANGED',
        message: 'Definition for agent "assistant" changed',
      });
    });
  });
});
