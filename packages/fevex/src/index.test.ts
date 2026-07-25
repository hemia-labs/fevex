import { describe, expect, test } from 'bun:test';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { AgentDefinition } from './agents';
import { SCHEMA_NOT_TRANSPORTABLE, type AgentEvent, type JsonObject, type ToolCall } from './core';
import type { ModelGateway, ModelGenerateInput } from './models';
import type { ToolExecutionContext } from './tools';
import {
  createFevex,
  defineAgent,
  defineTool,
} from './index';

type TestSchema<TOutput> = StandardSchemaV1<unknown, TOutput> & StandardJSONSchemaV1<unknown, TOutput>;

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

const passthroughSchema = <TOutput>(jsonSchema?: JsonObject): TestSchema<TOutput> => schema(
  (value) => ({ value: value as TOutput }),
  jsonSchema,
);

const agent = (name: string, overrides: Partial<AgentDefinition> = {}) => defineAgent({
  name,
  instructions: 'Answer clearly.',
  ...overrides,
});

const modelWithOutput = (output: unknown): ModelGateway => ({
  async generate() {
    return { output };
  },
});

const lookupCall: ToolCall = {
  id: 'call-1',
  name: 'lookup',
  input: { query: 'value' },
};

describe('createFevex', () => {
  test('runs the default model and forwards agent options', async () => {
    const calls: ModelGenerateInput[] = [];
    const agentSchema = passthroughSchema<string>({ type: 'string' });
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
      async generate(input) {
        calls.push(input);
        return {
          output: { answer: 'done' },
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      },
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
      agents: [agent('assistant', {
        tools: ['lookup'],
        reasoning: 'low',
        modelOptions: { temperature: 0 },
        outputSchema: agentSchema,
      })],
      tools: [lookup],
    });

    const result = await app.runAgent<{ question: string }, { answer: string }>('assistant', {
      input: { question: 'Ready?' },
      outputSchema: requestSchema,
      signal,
    });

    expect(result.output).toEqual({ answer: 'done' });
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    expect(calls[0]).toEqual({
      messages: [
        { role: 'system', content: 'Answer clearly.' },
        { role: 'user', content: '{"question":"Ready?"}' },
      ],
      tools: [{ name: 'lookup', description: 'Look up a value.', inputSchema: toolInputSchemaJson }],
      reasoning: 'low',
      modelOptions: { temperature: 0 },
      outputSchema: requestSchemaJson,
      signal,
    });
    expect(result.events?.map(({ type }) => type)).toEqual([
      'run.started',
      'model.completed',
      'run.completed',
    ]);
    expect(new Set(result.events?.map(({ runId }) => runId)).size).toBe(1);
    for (const event of result.events ?? []) {
      expect(event.runId).not.toBe('');
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    }

    await app.runAgent('assistant', { input: 'hello' });
    expect(calls[1]?.messages[1]?.content).toBe('hello');
    expect(calls[1]?.outputSchema).toEqual({ type: 'string' });
  });

  test('executes one tool and sends its result back to the model', async () => {
    const calls: ModelGenerateInput[] = [];
    const signal = new AbortController().signal;
    const context = { namespace: 'test' };
    const outputSchemaJson = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const outputSchema = passthroughSchema<{ answer: string }>(outputSchemaJson);
    let execution: { input: unknown; context: ToolExecutionContext } | undefined;
    const model: ModelGateway = {
      async generate(input) {
        calls.push(input);
        if (calls.length === 1) {
          return {
            output: 'Looking up the value.',
            toolCalls: [lookupCall],
            usage: { inputTokens: 3, totalTokens: 3 },
          };
        }
        return {
          output: { answer: 'found' },
          usage: { outputTokens: 2, totalTokens: 2 },
        };
      },
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
      agents: [agent('assistant', {
        tools: ['lookup'],
        reasoning: 'low',
        modelOptions: { temperature: 0 },
      })],
      tools: [lookup],
    });

    const result = await app.runAgent<unknown, { answer: string }>('assistant', {
      input: 'Find it.',
      context,
      outputSchema,
      signal,
    });
    const runId = result.events![0]!.runId;

    expect(result.output).toEqual({ answer: 'found' });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(execution).toEqual({
      input: { query: 'value' },
      context: { runId, toolCallId: 'call-1', context, signal },
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
      tools: undefined,
      reasoning: 'low',
      modelOptions: { temperature: 0 },
      outputSchema: outputSchemaJson,
      signal,
    });
    expect(result.events?.map(({ type }) => type)).toEqual([
      'run.started',
      'model.completed',
      'tool.completed',
      'model.completed',
      'run.completed',
    ]);
    expect(result.events?.[2]?.payload).toEqual({ toolCallId: 'call-1', toolName: 'lookup' });
    expect(new Set(result.events?.map((event) => event.runId))).toEqual(new Set([runId]));
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
      const calls: ModelGenerateInput[] = [];
      const model: ModelGateway = {
        async generate(input) {
          calls.push(input);
          return calls.length === 1 ? { toolCalls: [lookupCall] } : { output: 'done' };
        },
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
      async generate(input) {
        contents.push(input.messages[1]!.content);
        return { output: 'ok' };
      },
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
      async generate(input) {
        content = input.messages[1]!.content;
        return { output: { optional: undefined, result: 'ok' } };
      },
    };
    const app = createFevex({ models: { default: model }, agents: [agent('assistant')] });

    const result = await app.runAgent('assistant', {
      input: { optional: undefined, first: shared, second: shared },
    });

    expect(content).toBe('{"first":{"value":1},"second":{"value":1}}');
    expect(result.output).toEqual({ result: 'ok' });
  });

  test('validates and transforms every schema boundary', async () => {
    const calls: ModelGenerateInput[] = [];
    let agentSchemaCalls = 0;
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
    const inputSchema = schema<{ query: string }>((value) => ({
      value: { query: String((value as { query?: unknown }).query).toUpperCase() },
    }), inputSchemaJson);
    const toolOutputSchema = schema<{ found: string }>(async (value) => ({
      value: { found: (value as { found: string }).found.toUpperCase() },
    }));
    const agentOutputSchema = schema<{ answer: string }>(() => {
      agentSchemaCalls += 1;
      return { issues: [{ message: 'agent schema should not run' }] };
    });
    const requestOutputSchema = schema<{ answer: string }>((value) => ({
      value: { answer: (value as { answer: string }).answer.toUpperCase() },
    }), requestOutputSchemaJson);
    const model: ModelGateway = {
      async generate(input) {
        calls.push(input);
        return calls.length === 1
          ? { toolCalls: [lookupCall] }
          : { output: { answer: 'done' } };
      },
    };
    const app = createFevex({
      models: { default: model },
      agents: [agent('assistant', {
        tools: ['lookup'],
        outputSchema: agentOutputSchema,
      })],
      tools: [defineTool({
        name: 'lookup',
        inputSchema,
        outputSchema: toolOutputSchema,
        execute(input) {
          toolInput = input;
          return { found: 'yes' };
        },
      })],
    });

    const result = await app.runAgent<unknown, { answer: string }>('assistant', {
      input: 'hello',
      outputSchema: requestOutputSchema,
    });

    expect(toolInput).toEqual({ query: 'VALUE' });
    expect(calls[0]?.tools?.[0]?.inputSchema).toEqual(inputSchemaJson);
    expect(calls[0]?.outputSchema).toEqual(requestOutputSchemaJson);
    expect(calls[1]?.messages[3]?.content).toBe('{"found":"YES"}');
    expect(result.output).toEqual({ answer: 'DONE' });
    expect(agentSchemaCalls).toBe(0);
  });

  test('emits observable failures for tool and output schema issues', async () => {
    let executed = false;
    const inputEvents: AgentEvent[] = [];
    const invalidInput = schema(() => ({
      issues: [{ message: 'query is required' }],
    }));
    const inputApp = createFevex({
      models: { default: { async generate() { return { toolCalls: [lookupCall] }; } } },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [defineTool({
        name: 'lookup',
        inputSchema: invalidInput,
        execute() {
          executed = true;
        },
      })],
      onEvent(event) {
        inputEvents.push(event);
      },
    });

    await expect(inputApp.runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Input for tool "lookup" does not match inputSchema: query is required');
    expect(executed).toBe(false);
    expect(inputEvents.map(({ type }) => type)).toEqual([
      'run.started',
      'model.completed',
      'tool.failed',
      'run.failed',
    ]);
    expect(inputEvents[2]?.payload).toEqual({
      toolCallId: 'call-1',
      toolName: 'lookup',
      error: 'Input for tool "lookup" does not match inputSchema: query is required',
    });

    const toolOutputEvents: AgentEvent[] = [];
    const invalidToolOutput = schema(async () => ({
      issues: [{ message: 'tool result is invalid' }],
    }));
    const toolOutputApp = createFevex({
      models: { default: { async generate() { return { toolCalls: [lookupCall] }; } } },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [defineTool({
        name: 'lookup',
        outputSchema: invalidToolOutput,
        execute() {
          return { found: false };
        },
      })],
      onEvent(event) {
        toolOutputEvents.push(event);
      },
    });

    await expect(toolOutputApp.runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Output from tool "lookup" does not match outputSchema: tool result is invalid');
    expect(toolOutputEvents.map(({ type }) => type)).toEqual([
      'run.started',
      'model.completed',
      'tool.failed',
      'run.failed',
    ]);

    const outputEvents: AgentEvent[] = [];
    const invalidOutput = schema(async () => ({
      issues: [{ message: 'status is invalid' }],
    }));
    const outputApp = createFevex({
      models: { default: { async generate() { return { output: { status: 'bad' } }; } } },
      agents: [agent('assistant', { outputSchema: invalidOutput })],
      onEvent(event) {
        outputEvents.push(event);
      },
    });

    await expect(outputApp.runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Output from agent "assistant" does not match outputSchema: status is invalid');
    expect(outputEvents.map(({ type }) => type)).toEqual([
      'run.started',
      'model.completed',
      'run.failed',
    ]);
  });

  test('notifies successful events and treats observer errors as run failures', async () => {
    const observed: AgentEvent[] = [];
    const app = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('assistant')],
      onEvent(event) {
        observed.push(event);
      },
    });

    const result = await app.runAgent('assistant', { input: 'hello' });
    expect(observed).toEqual(result.events ?? []);

    const observerError = new Error('observer failed');
    const failedTypes: string[] = [];
    const failedApp = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('assistant')],
      onEvent(event) {
        failedTypes.push(event.type);
        if (event.type === 'model.completed') throw observerError;
      },
    });

    await expect(failedApp.runAgent('assistant', { input: 'hello' })).rejects.toBe(observerError);
    expect(failedTypes).toEqual(['run.started', 'model.completed', 'run.failed']);
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

    await expect(app.runAgent<unknown, string>('default-agent', { input: '' }))
      .resolves.toMatchObject({ output: 'default' });
    await expect(app.runAgent<unknown, string>('named-agent', { input: '' }))
      .resolves.toMatchObject({ output: 'named' });
    await expect(app.runAgent<unknown, string>('direct-agent', { input: '' }))
      .resolves.toMatchObject({ output: 'direct' });
  });

  test('validates configuration at startup', () => {
    const model = modelWithOutput('ok');
    const duplicateTool = defineTool({ name: 'lookup', execute() {} });

    expect(() => createFevex({
      models: { default: model },
      agents: [agent('same'), agent('same')],
    })).toThrow('Agent "same" is duplicated');
    expect(() => createFevex({
      models: { default: model },
      agents: [],
      tools: [duplicateTool, duplicateTool],
    })).toThrow('Tool "lookup" is duplicated');
    expect(() => createFevex({ models: {}, agents: [agent('assistant')] }))
      .toThrow('Default model "default" required by agent "assistant" is not registered');
    expect(() => createFevex({
      models: { default: model },
      agents: [agent('assistant', { model: 'missing' })],
    })).toThrow('Model "missing" required by agent "assistant" is not registered');
    expect(() => createFevex({
      models: { default: model },
      agents: [agent('assistant', { tools: ['missing'] })],
    })).toThrow('Tool "missing" required by agent "assistant" is not registered');
    expect(() => createFevex({ models: { default: model }, agents: [agent(' ')] }))
      .toThrow('Agent name cannot be empty');
    expect(() => createFevex({
      models: { default: model },
      agents: [agent('assistant', { instructions: ' ' })],
    })).toThrow('Agent "assistant" instructions cannot be empty');
    expect(() => createFevex({
      models: { ' ': model },
      agents: [],
    })).toThrow('Model name cannot be empty');
    expect(() => createFevex({
      models: { default: {} as ModelGateway },
      agents: [],
    })).toThrow('Model "default" must implement generate');
    expect(() => createFevex({
      models: { default: model },
      agents: [agent('assistant', { outputSchema: {} as StandardSchemaV1 })],
    })).toThrow('Output schema for agent "assistant" must implement Standard Schema');
    expect(() => createFevex({
      models: { default: model },
      agents: [],
      tools: [defineTool({
        name: 'lookup',
        inputSchema: {} as StandardSchemaV1,
        execute() {},
      })],
    })).toThrow('Input schema for tool "lookup" must implement Standard Schema');
  });

  test('rejects unknown agents and non-serializable input', async () => {
    const app = createFevex({
      models: { default: modelWithOutput('ok') },
      agents: [agent('assistant')],
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    await expect(app.runAgent('missing', { input: 'hello' }))
      .rejects.toThrow('Agent "missing" is not registered');
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
      await expect(app.runAgent('assistant', { input }))
        .rejects.toThrow('Run input must be a string or JSON-serializable value');
    }
  });

  test('rejects incomplete model results', async () => {
    let noFinalCalls = 0;
    const app = createFevex({
      models: {},
      agents: [
        agent('no-output', { model: { async generate() { return {}; } } }),
        agent('no-final-output', {
          model: {
            async generate() {
              noFinalCalls += 1;
              return noFinalCalls === 1 ? { toolCalls: [lookupCall] } : {};
            },
          },
          tools: ['lookup'],
        }),
      ],
      tools: [defineTool({ name: 'lookup', execute: () => 'found' })],
    });

    await expect(app.runAgent('no-output', { input: 'hello' }))
      .rejects.toThrow('Model for agent "no-output" returned no output');
    await expect(app.runAgent('no-final-output', { input: 'hello' }))
      .rejects.toThrow('Model for agent "no-final-output" returned no output');
  });

  test('rejects invalid or unavailable tool calls before execution', async () => {
    let executions = 0;
    const lookup = defineTool({ name: 'lookup', execute() { executions += 1; } });
    const hidden = defineTool({ name: 'hidden', execute() { executions += 1; } });
    const appFor = (toolCalls: ToolCall[], declaredTools = ['lookup']) => createFevex({
      models: { default: { async generate() { return { toolCalls }; } } },
      agents: [agent('assistant', { tools: declaredTools })],
      tools: [lookup, hidden],
    });

    await expect(appFor([lookupCall, { ...lookupCall, id: 'call-2' }])
      .runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Agent "assistant" requested multiple tools, but this runtime supports one tool call');
    await expect(appFor([{ ...lookupCall, id: '' }]).runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Tool call id cannot be empty');
    await expect(appFor([{ ...lookupCall, name: '' }]).runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Tool call name cannot be empty');
    await expect(appFor([{ ...lookupCall, name: 'hidden' }]).runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Tool "hidden" is not available to agent "assistant"');
    expect(executions).toBe(0);
  });

  test('rejects another tool call from the final model turn', async () => {
    let calls = 0;
    const app = createFevex({
      models: {
        default: {
          async generate() {
            calls += 1;
            return { toolCalls: [lookupCall] };
          },
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [defineTool({ name: 'lookup', execute: () => 'found' })],
    });

    await expect(app.runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Agent "assistant" requested another tool, but this runtime supports one tool call');
    expect(calls).toBe(2);
  });

  test('rejects non-serializable tool input and output', async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let inputToolCalled = false;
    const inputApp = createFevex({
      models: {
        default: {
          async generate() {
            return { toolCalls: [{ ...lookupCall, input: cyclic as never }] };
          },
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [defineTool({ name: 'lookup', execute() { inputToolCalled = true; } })],
    });

    await expect(inputApp.runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Input for tool "lookup" must be JSON-serializable');
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
        models: { default: { async generate() { return { toolCalls: [lookupCall] }; } } },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [defineTool({ name: 'lookup', execute: () => output })],
      });

      await expect(outputApp.runAgent('assistant', { input: 'hello' }))
        .rejects.toThrow('Output from tool "lookup" must be JSON-serializable');
    }
  });

  test('rejects non-serializable final and schema-transformed outputs', async () => {
    const finalApp = createFevex({
      models: { default: modelWithOutput(new Date()) },
      agents: [agent('assistant')],
    });

    await expect(finalApp.runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Output from agent "assistant" must be JSON-serializable');

    const transformedApp = createFevex({
      models: { default: modelWithOutput('date') },
      agents: [agent('assistant', {
        outputSchema: schema(() => ({ value: new Date() })),
      })],
    });

    await expect(transformedApp.runAgent('assistant', { input: 'hello' }))
      .rejects.toThrow('Output from agent "assistant" must be JSON-serializable');
  });

  test('fails before the model when active schemas are not transportable', async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const app = createFevex({
      models: {
        default: {
          async generate() {
            modelCalls += 1;
            return { output: 'unexpected' };
          },
        },
      },
      agents: [agent('assistant', {
        outputSchema: schemaOnly((value) => ({ value: value as string })),
      })],
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(app.runAgent('assistant', { input: 'hello' })).rejects.toMatchObject({
      code: SCHEMA_NOT_TRANSPORTABLE,
      message: 'Output schema for agent "assistant" is not transportable: schema does not implement Standard JSON Schema',
    });
    expect(modelCalls).toBe(0);
    expect(events.map(({ type }) => type)).toEqual(['run.started', 'run.failed']);
  });

  test('fails before the model when schema conversion throws or returns invalid JSON Schema', async () => {
    const throwingSchema = schema(
      (value) => ({ value: value as string }),
      { type: 'string' },
    );
    (throwingSchema['~standard'].jsonSchema as unknown as { output: () => JsonObject }).output = () => {
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

    const invalidJsonSchema = schema(
      (value) => ({ value: value as { query: string } }),
      { type: 'object' },
    );
    (invalidJsonSchema['~standard'].jsonSchema as unknown as { input: () => JsonObject }).input = () => new Date() as never;
    let modelCalls = 0;
    const inputApp = createFevex({
      models: {
        default: {
          async generate() {
            modelCalls += 1;
            return { toolCalls: [lookupCall] };
          },
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [defineTool({
        name: 'lookup',
        inputSchema: invalidJsonSchema,
        execute() {},
      })],
    });

    await expect(inputApp.runAgent('assistant', { input: 'hello' })).rejects.toMatchObject({
      code: SCHEMA_NOT_TRANSPORTABLE,
      message: 'Input schema for tool "lookup" is not transportable: JSON Schema must be JSON-serializable',
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
            async generate() {
              abortedModelCalled = true;
              return { output: 'unexpected' };
            },
          },
        }),
        agent('failure', {
          model: {
            async generate() {
              throw providerError;
            },
          },
        }),
      ],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(app.runAgent('aborted', { input: 'hello', signal: controller.signal }))
      .rejects.toThrow();
    expect(abortedModelCalled).toBe(false);
    await expect(app.runAgent('failure', { input: 'hello' })).rejects.toBe(providerError);
  });

  test('checks cancellation around tools and preserves tool errors', async () => {
    const beforeToolController = new AbortController();
    let beforeToolCalled = false;
    const beforeToolApp = createFevex({
      models: {
        default: {
          async generate() {
            beforeToolController.abort();
            return { toolCalls: [lookupCall] };
          },
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [defineTool({ name: 'lookup', execute() { beforeToolCalled = true; } })],
    });

    await expect(beforeToolApp.runAgent('assistant', {
      input: 'hello',
      signal: beforeToolController.signal,
    })).rejects.toThrow();
    expect(beforeToolCalled).toBe(false);

    const beforeModelController = new AbortController();
    let modelCalls = 0;
    const beforeModelApp = createFevex({
      models: {
        default: {
          async generate() {
            modelCalls += 1;
            return { toolCalls: [lookupCall] };
          },
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [defineTool({
        name: 'lookup',
        execute() {
          beforeModelController.abort();
          return 'found';
        },
      })],
    });

    await expect(beforeModelApp.runAgent('assistant', {
      input: 'hello',
      signal: beforeModelController.signal,
    })).rejects.toThrow();
    expect(modelCalls).toBe(1);

    const toolError = new Error('tool failed');
    const failureTypes: string[] = [];
    const observerError = new Error('observer failed');
    const errorApp = createFevex({
      models: { default: { async generate() { return { toolCalls: [lookupCall] }; } } },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [defineTool({ name: 'lookup', execute() { throw toolError; } })],
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
      'model.completed',
      'tool.failed',
      'run.failed',
    ]);
  });
});
