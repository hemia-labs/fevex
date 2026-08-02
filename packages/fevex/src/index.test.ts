import { describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  PROVIDER_REASONING_UNSUPPORTED,
  PROVIDER_SCHEMA_UNSUPPORTED,
  SCHEMA_NOT_TRANSPORTABLE,
  type AgentEvent,
  type JsonObject,
  type ToolCall,
} from './core';
import type { ModelGateway, ModelInput } from './models';
import {
  createFevex,
  defineAgent,
  defineTool,
  defineWorkflow,
  FevexConfigurationError,
  type FevexConfigurationErrorCode,
} from './index';
import {
  agent,
  getConfigurationError,
  lookupCall,
  modelWithOutput,
  schema,
  schemaOnly,
  streamFrom,
} from './test-fixtures';

describe('createFevex', () => {
  test('exports distinct schema boundary error codes', () => {
    expect(SCHEMA_NOT_TRANSPORTABLE).toBe('SCHEMA_NOT_TRANSPORTABLE');
    expect(PROVIDER_SCHEMA_UNSUPPORTED).toBe('PROVIDER_SCHEMA_UNSUPPORTED');
    expect(PROVIDER_REASONING_UNSUPPORTED).toBe('PROVIDER_REASONING_UNSUPPORTED');
  });

  test('accepts extended reasoning effort levels', () => {
    for (const reasoning of ['xhigh', 'max'] as const) {
      expect(() => createFevex({
        models: { default: modelWithOutput('ok') },
        agents: [agent('assistant', { reasoning })],
      })).not.toThrow();
    }
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
});
