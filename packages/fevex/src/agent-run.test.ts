import { describe, expect, test } from 'bun:test';
import { type AgentEvent, type JsonObject } from './core';
import type { ModelGateway, ModelInput } from './models';
import type { ToolExecutionContext } from './tools';
import { createFevex, defineTool, SandboxError } from './index';
import {
  agent,
  lookupCall,
  modelWithOutput,
  passthroughSchema,
  schema,
  streamFrom,
} from './test-fixtures';

describe('agent runs', () => {
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
});
