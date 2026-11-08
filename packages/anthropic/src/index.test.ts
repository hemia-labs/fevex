import { describe, expect, test } from 'bun:test';
import {
  PROVIDER_REASONING_UNSUPPORTED,
  PROVIDER_SCHEMA_UNSUPPORTED,
  createFevex,
  defineAgent,
  defineTool,
  type JsonObject,
  type ModelGateway,
  type ModelInput,
  type ModelResult,
} from '@fevex/core';
import { testModelGateway } from '@fevex/core/testing';
import { createAnthropic, AnthropicError } from './index';
import { findAnthropicSchemaIssue } from './internal/provider-schema';

const ok = (events: Array<Record<string, unknown>>) =>
  new Response(toAnthropicSSE(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_ok' },
  });

const input = (overrides: Partial<ModelInput> = {}): ModelInput => ({
  messages: [{ role: 'user', content: 'Hello' }],
  ...overrides,
});

async function collectModel(model: ModelGateway, modelInput: ModelInput): Promise<ModelResult> {
  let result: ModelResult | undefined;
  for await (const event of model.stream(modelInput)) {
    if (event.type === 'completed') result = event.result;
  }
  if (!result) throw new Error('Model stream did not complete');
  return result;
}

function toAnthropicSSE(events: Array<Record<string, unknown>>, lineEnding = '\n'): string {
  return events
    .map((event) => `event: ${event.type}${lineEnding}data: ${JSON.stringify(event)}${lineEnding}${lineEnding}`)
    .join('');
}

function fragmentedSSE(value: string): Response {
  const bytes = new TextEncoder().encode(value);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
    {
      headers: { 'content-type': 'text/event-stream', 'request-id': 'req_stream' },
    },
  );
}

const messageStart = (usage?: Record<string, number>) => ({
  type: 'message_start',
  message: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'test-model',
    stop_reason: null,
    stop_sequence: null,
    ...(usage ? { usage } : {}),
  },
});

const messageDelta = (stopReason: unknown, usage?: Record<string, number>) => ({
  type: 'message_delta',
  delta: { stop_reason: stopReason, stop_sequence: null },
  ...(usage ? { usage } : {}),
});

function textEvents(
  text: string,
  options: {
    stopReason?: string;
    usage?: Record<string, number>;
    outputUsage?: Record<string, number>;
  } = {},
): Array<Record<string, unknown>> {
  return [
    messageStart(options.usage),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...(text
      ? [{
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }]
      : []),
    { type: 'content_block_stop', index: 0 },
    messageDelta(options.stopReason ?? 'end_turn', options.outputUsage),
    { type: 'message_stop' },
  ];
}

function toolEvents(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  options: {
    thinking?: { thinking: string; signature: string };
    stopReason?: string;
  } = {},
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [messageStart()];
  let index = 0;
  if (options.thinking) {
    events.push(
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: options.thinking.thinking },
      },
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: options.thinking.signature },
      },
      { type: 'content_block_stop', index },
    );
    index += 1;
  }
  for (const call of calls) {
    events.push(
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      },
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
      },
      { type: 'content_block_stop', index },
    );
    index += 1;
  }
  events.push(
    messageDelta(options.stopReason ?? 'tool_use', { output_tokens: 2 }),
    { type: 'message_stop' },
  );
  return events;
}

const outputSchema: JsonObject = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

const toolSchema: JsonObject = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
};

const tool = {
  name: 'lookup',
  description: 'Look up a value.',
  inputSchema: toolSchema,
} satisfies NonNullable<ModelInput['tools']>[number];

describe('createAnthropic', () => {
  test('builds a Messages request from model input', async () => {
    const requests: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    const model = createAnthropic({
      apiKey: 'test-key',
      apiVersion: '2026-10-21',
      fetch: async (url, init) => {
        requests.push({ url, init });
        return ok(textEvents('done', {
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
          },
        }));
      },
    })('test-model');

    const result = await collectModel(
      model,
      input({
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hello' },
        ],
        reasoning: 'high',
        modelOptions: {
          temperature: 0,
          model: 'ignored-model',
          messages: [{ role: 'user', content: 'ignored' }],
          system: 'ignored-system',
          tools: [{ name: 'ignored' }],
          tool_choice: 'none',
          max_tokens: 50,
          output_config: { task_budget: { type: 'tokens', total: 1000 } },
          thinking: { type: 'enabled', budget_tokens: 1000 },
          stream: false,
        },
      }),
    );

    const request = requests[0]!;
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.init?.method).toBe('POST');
    expect(request.init?.headers).toEqual({
      'x-api-key': 'test-key',
      'anthropic-version': '2026-10-21',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    });
    expect(JSON.parse(request.init?.body as string)).toEqual({
      model: 'test-model',
      max_tokens: 50,
      system: 'Be brief.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      output_config: {
        task_budget: { type: 'tokens', total: 1000 },
        effort: 'high',
      },
      thinking: { type: 'enabled', budget_tokens: 1000 },
      stream: true,
      temperature: 0,
    });
    expect(result).toEqual({
      output: 'done',
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
  });

  test('uses the strictest output token cap and defaults to 4096', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(textEvents('done'));
      },
    })('test-model');

    await collectModel(model, input());
    await collectModel(
      model,
      input({ maxOutputTokens: 30, modelOptions: { max_tokens: 50 } }),
    );
    await collectModel(
      model,
      input({ maxOutputTokens: 50, modelOptions: { max_tokens: 20 } }),
    );

    expect(bodies.map(({ max_tokens }) => max_tokens)).toEqual([4_096, 30, 20]);
  });

  test('translates neutral toolChoice', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createAnthropic({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(textEvents('done'));
      },
    })('test-model');

    for (const toolChoice of ['auto', 'required', 'none', { name: 'lookup' }] as const) {
      await collectModel(model, input({ tools: [tool], toolChoice }));
    }

    expect(bodies.map(({ tool_choice }) => tool_choice)).toEqual([
      { type: 'auto', disable_parallel_tool_use: true },
      { type: 'any', disable_parallel_tool_use: true },
      { type: 'none' },
      { type: 'tool', name: 'lookup', disable_parallel_tool_use: true },
    ]);
  });

  test('sends strict tools and replays native thinking and tool state', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const responses = [
      toolEvents(
        [{ id: 'call-1', name: 'lookup', input: { query: 'value' } }],
        { thinking: { thinking: 'private reasoning', signature: 'sig-1' } },
      ),
      textEvents('{"answer":"found"}'),
    ];
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(responses.shift()!);
      },
    })('test-model');

    const first = await collectModel(
      model,
      input({
        messages: [{ role: 'user', content: 'Find it' }],
        tools: [tool],
        outputSchema,
      }),
    );
    await expect(
      collectModel(
        model,
        input({
          messages: [
            { role: 'user', content: 'Find it' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'other-call', name: 'lookup', input: {} }],
            },
            { role: 'tool', toolCallId: 'other-call', content: '{}' },
          ],
          tools: [tool],
          outputSchema,
          providerState: first.providerState,
        }),
      ),
    ).rejects.toThrow('providerState does not match');
    expect(bodies).toHaveLength(1);

    const second = await collectModel(
      model,
      input({
        messages: [
          { role: 'user', content: 'Find it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: first.toolCalls,
          },
          {
            role: 'tool',
            name: 'lookup',
            toolCallId: 'call-1',
            content: '{"found":true}',
          },
        ],
        tools: [tool],
        outputSchema,
        providerState: first.providerState,
      }),
    );

    expect(bodies[0]).toEqual({
      model: 'test-model',
      max_tokens: 4_096,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Find it' }] }],
      tools: [{
        name: 'lookup',
        description: 'Look up a value.',
        input_schema: toolSchema,
        strict: true,
      }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      output_config: {
        format: { type: 'json_schema', schema: outputSchema },
      },
      stream: true,
    });
    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private reasoning', signature: 'sig-1' },
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'lookup',
            input: { query: 'value' },
          },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: '{"found":true}',
        }],
      },
    ]);
    expect(first.toolCalls).toEqual([
      { id: 'call-1', name: 'lookup', input: { query: 'value' } },
    ]);
    expect(first.providerState).toBeDefined();
    expect(second.output).toEqual({ answer: 'found' });
  });

  test('groups consecutive tool results into one user turn', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const responses = [
      toolEvents([
        { id: 'call-1', name: 'lookup', input: { query: 'first' } },
        { id: 'call-2', name: 'lookup', input: { query: 'second' } },
      ]),
      textEvents('done'),
    ];
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(responses.shift()!);
      },
    })('test-model');

    const first = await collectModel(
      model,
      input({
        messages: [{ role: 'user', content: 'Find it' }],
        tools: [tool],
      }),
    );
    await collectModel(
      model,
      input({
        messages: [
          { role: 'user', content: 'Find it' },
          { role: 'assistant', content: '', toolCalls: first.toolCalls },
          { role: 'tool', toolCallId: 'call-1', content: '{"a":1}' },
          { role: 'tool', toolCallId: 'call-2', content: '{"b":2}' },
        ],
        tools: [tool],
        providerState: first.providerState,
      }),
    );

    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call-1', name: 'lookup', input: { query: 'first' } },
          { type: 'tool_use', id: 'call-2', name: 'lookup', input: { query: 'second' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: '{"a":1}' },
          { type: 'tool_result', tool_use_id: 'call-2', content: '{"b":2}' },
        ],
      },
    ]);
  });

  test('rejects unsupported strict schemas before fetch', async () => {
    let fetchCalls = 0;
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async () => {
        fetchCalls += 1;
        return ok(textEvents('{}'));
      },
    })('test-model');
    const tooManyProperties = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`field${index}`, { type: 'string' }]),
    );
    const tooManyUnions = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `field${index}`,
        { anyOf: [{ type: 'string' }, { type: 'number' }] },
      ]),
    );
    const cases: ModelInput[] = [
      input({ outputSchema: { type: 'string' } }),
      input({
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      }),
      input({
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'number', minimum: 1 } },
          required: ['value'],
          additionalProperties: false,
        },
      }),
      input({
        outputSchema: {
          type: 'object',
          properties: {
            values: { type: 'array', items: { type: 'string' }, minItems: 2 },
          },
          required: ['values'],
          additionalProperties: false,
        },
      }),
      input({
        outputSchema: {
          type: 'object',
          properties: { value: { $ref: 'https://example.com/schema.json' } },
          required: ['value'],
          additionalProperties: false,
        },
      }),
      input({
        outputSchema: {
          type: 'object',
          properties: {
            node: { $ref: '#/$defs/Node' },
          },
          required: ['node'],
          additionalProperties: false,
          $defs: {
            Node: {
              type: 'object',
              properties: { child: { $ref: '#/$defs/Node' } },
              required: ['child'],
              additionalProperties: false,
            },
          },
        },
      }),
      input({
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'string', pattern: '(?=x)' } },
          required: ['value'],
          additionalProperties: false,
        },
      }),
      input({
        outputSchema: {
          type: 'object',
          properties: tooManyProperties,
          required: [],
          additionalProperties: false,
        },
      }),
      input({
        outputSchema: {
          type: 'object',
          properties: tooManyUnions,
          required: [],
          additionalProperties: false,
        },
      }),
      input({
        tools: Array.from({ length: 21 }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: emptyObjectSchema,
        })),
      }),
    ];

    for (const invalidInput of cases) {
      await expect(collectModel(model, invalidInput)).rejects.toMatchObject({
        name: 'AnthropicError',
        code: PROVIDER_SCHEMA_UNSUPPORTED,
      });
    }
    expect(fetchCalls).toBe(0);
  });

  test('uses schema instructions in best-effort mode', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createAnthropic({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(textEvents('{"answer":"done"}'));
      },
    })('test-model');

    await collectModel(
      model,
      input({
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hello' },
        ],
        tools: [tool],
        outputSchema,
        modelOptions: {
          output_config: { format: { type: 'json_schema', schema: { type: 'string' } } },
        },
      }),
    );

    expect(bodies[0]?.tools).toEqual([{
      name: 'lookup',
      description: 'Look up a value.',
      input_schema: toolSchema,
    }]);
    expect(bodies[0]?.output_config).toBeUndefined();
    expect(bodies[0]?.system).toContain('matching this schema');
    expect(bodies[0]?.system).toContain('Be brief.');
    expect(JSON.stringify(bodies[0]?.messages)).not.toContain('ignored');
  });

  test('preserves JSON-looking plain text without an output schema', async () => {
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async () => ok(textEvents('{"answer":"done"}')),
    })('test-model');

    await expect(collectModel(model, input())).resolves.toEqual({
      output: '{"answer":"done"}',
    });
  });

  test('preserves exact plain text and parses only requested structured output', async () => {
    const plainValues = ['123', 'true', 'null', '""', '  {"x":1}\n', ''];
    const plainModel = createAnthropic({
      apiKey: 'test-key',
      fetch: async () => ok(textEvents(plainValues.shift()!)),
    })('test-model');

    for (const expected of ['123', 'true', 'null', '""', '  {"x":1}\n', '']) {
      await expect(collectModel(plainModel, input())).resolves.toEqual({
        output: expected,
      });
    }

    const structuredValues = ['{"answer":"done"}', '"done"', 'not-json'];
    const structuredModel = createAnthropic({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async () => ok(textEvents(structuredValues.shift()!)),
    })('test-model');
    await expect(
      collectModel(structuredModel, input({ outputSchema: { type: 'object' } })),
    ).resolves.toEqual({ output: { answer: 'done' } });
    await expect(
      collectModel(structuredModel, input({ outputSchema: { type: 'object' } })),
    ).resolves.toEqual({ output: 'done' });
    await expect(
      collectModel(structuredModel, input({ outputSchema: { type: 'object' } })),
    ).rejects.toThrow('Anthropic structured output was not valid JSON');
  });

  test('rejects refusals, truncated responses and malformed tool calls', async () => {
    const responses = [
      textEvents('not allowed', { stopReason: 'refusal' }),
      textEvents('partial', { stopReason: 'max_tokens' }),
      toolEvents([], { stopReason: 'tool_use' }),
      toolEvents([{ id: 'call-1', name: 'lookup', input: { query: 'value' } }], {
        stopReason: 'end_turn',
      }),
      [
        messageStart(),
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{' },
        },
        { type: 'content_block_stop', index: 0 },
        messageDelta('tool_use'),
        { type: 'message_stop' },
      ],
    ];
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async () => ok(responses.shift()!),
    })('test-model');

    await expect(collectModel(model, input())).rejects.toThrow(
      'Anthropic refused the response: not allowed',
    );
    await expect(collectModel(model, input())).rejects.toThrow(
      'Anthropic response stopped with stop_reason "max_tokens"',
    );
    await expect(collectModel(model, input())).rejects.toThrow(
      'Anthropic stop_reason does not match the tool call payload',
    );
    await expect(collectModel(model, input())).rejects.toThrow(
      'Anthropic stop_reason does not match the tool call payload',
    );
    await expect(collectModel(model, input())).rejects.toThrow(
      'Anthropic tool call "lookup" returned invalid JSON arguments',
    );
  });

  test('validates provider state, tool names and message references before fetch', async () => {
    let fetchCalls = 0;
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async () => {
        fetchCalls += 1;
        return ok(textEvents('done'));
      },
    })('test-model');

    await expect(
      collectModel(model, input({ tools: [{ name: 'invalid tool' }] })),
    ).rejects.toThrow('[A-Za-z0-9_-]{1,64}');
    await expect(
      collectModel(model, input({
        messages: [{ role: 'tool', toolCallId: 'missing', content: 'done' }],
      })),
    ).rejects.toThrow('invalid toolCallId');
    await expect(
      collectModel(model, input({ providerState: {} })),
    ).rejects.toThrow('providerState is invalid');
    await expect(
      collectModel(model, input({
        messages: [
          { role: 'user', content: 'Find it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'lookup', input: {} }],
          },
          { role: 'tool', toolCallId: 'call-1', content: '{}' },
        ],
      })),
    ).rejects.toThrow('providerState is required');
    await expect(
      collectModel(model, input({
        tools: [tool],
        toolChoice: { name: 'invalid tool' },
      })),
    ).rejects.toThrow('toolChoice is invalid');
    await expect(
      collectModel(model, input({ reasoning: 'minimal' })),
    ).rejects.toMatchObject({
      name: 'AnthropicError',
      code: PROVIDER_REASONING_UNSUPPORTED,
    });
    await expect(
      collectModel(model, input({ modelOptions: { max_tokens: 0 } })),
    ).rejects.toThrow('max_tokens must be a positive integer');
    await expect(
      collectModel(model, input({ modelOptions: { thinking: 'enabled' } })),
    ).rejects.toThrow('thinking must be an object');
    expect(fetchCalls).toBe(0);
  });

  test('maps neutral reasoning efforts and preserves provider options', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(textEvents('done'));
      },
    })('test-model');

    await collectModel(
      model,
      input({
        modelOptions: {
          output_config: { effort: 'xhigh', task_budget: { type: 'tokens', total: 10 } },
          thinking: { type: 'adaptive' },
        },
      }),
    );
    await collectModel(
      model,
      input({
        reasoning: 'none',
        modelOptions: {
          output_config: { effort: 'xhigh' },
          thinking: { type: 'adaptive' },
        },
      }),
    );
    for (const reasoning of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      await collectModel(model, input({ reasoning }));
    }

    expect(bodies.map(({ output_config }) => output_config)).toEqual([
      { effort: 'xhigh', task_budget: { type: 'tokens', total: 10 } },
      undefined,
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
      { effort: 'xhigh' },
      { effort: 'max' },
    ]);
    expect(bodies.map(({ thinking }) => thinking)).toEqual([
      { type: 'adaptive' },
      { type: 'disabled' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('preserves abort and reports HTTP failures', async () => {
    const controller = new AbortController();
    const abortReason = new Error('stop now');
    controller.abort(abortReason);
    const abortedModel = createAnthropic({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        return ok(textEvents('done'));
      },
    })('test-model');

    await expect(
      collectModel(abortedModel, input({ signal: controller.signal })),
    ).rejects.toBe(abortReason);

    const streamingController = new AbortController();
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    let cancelled = false;
    const streamingModel = createAnthropic({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              markReading();
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    })('test-model');
    const streamingRun = collectModel(
      streamingModel,
      input({ signal: streamingController.signal }),
    );
    await reading;
    streamingController.abort(abortReason);
    await expect(streamingRun).rejects.toBe(abortReason);
    expect(cancelled).toBe(true);

    const failingModel = createAnthropic({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }),
          {
            status: 400,
            headers: { 'request-id': 'req_bad' },
          },
        ),
    })('test-model');

    await expect(collectModel(failingModel, input())).rejects.toMatchObject({
      name: 'AnthropicError',
      message: 'bad request',
      status: 400,
      requestId: 'req_bad',
    });
  });

  test('streams UTF-8 deltas from arbitrarily fragmented SSE frames', async () => {
    const output = 'hé🦊';
    const events = [
      messageStart({ input_tokens: 1 }),
      { type: 'ping' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'private' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'hé' } },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: '🦊' },
      },
      { type: 'content_block_stop', index: 1 },
      messageDelta('end_turn', { output_tokens: 2 }),
      { type: 'message_stop' },
    ];
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async () =>
        fragmentedSSE([
          `${toAnthropicSSE(events.slice(0, 4), '\r\n')}`,
          `: keep-alive\r\n\r\n`,
          `${toAnthropicSSE(events.slice(4), '\r\n')}`,
        ].join('')),
    })('test-model');
    const streamed: string[] = [];
    let result: ModelResult | undefined;

    for await (const event of model.stream(input())) {
      if (event.type === 'output.delta') streamed.push(event.delta);
      else result = event.result;
    }

    expect(streamed.join('')).toBe(output);
    expect(result?.output).toBe(output);
  });

  test('rejects invalid or unterminated Anthropic streams', async () => {
    const invalid = createAnthropic({
      apiKey: 'test-key',
      fetch: async () => fragmentedSSE('data: {\n\n'),
    })('test-model');
    await expect(collectModel(invalid, input())).rejects.toThrow(
      'Anthropic stream event was not valid JSON',
    );

    const unterminated = createAnthropic({
      apiKey: 'test-key',
      fetch: async () => fragmentedSSE(toAnthropicSSE([
        messageStart(),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial' },
        },
        { type: 'content_block_stop', index: 0 },
      ])),
    })('test-model');
    await expect(collectModel(unterminated, input())).rejects.toThrow(
      'Anthropic stream ended without message_stop',
    );

    const unknownDelta = createAnthropic({
      apiKey: 'test-key',
      fetch: async () => ok([
        messageStart(),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'citation_delta' } },
        { type: 'content_block_stop', index: 0 },
        messageDelta('end_turn'),
        { type: 'message_stop' },
      ]),
    })('test-model');
    await expect(collectModel(unknownDelta, input())).rejects.toThrow(
      'Anthropic content delta type "citation_delta" is unsupported',
    );
  });

  test('replays redacted thinking blocks between tool rounds', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const responses = [
      [
        messageStart(),
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'redacted_thinking', data: 'opaque-thinking' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
        { type: 'content_block_stop', index: 1 },
        messageDelta('tool_use'),
        { type: 'message_stop' },
      ],
      textEvents('done'),
    ];
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(responses.shift()!);
      },
    })('test-model');

    const first = await collectModel(
      model,
      input({
        messages: [{ role: 'user', content: 'Find it' }],
        tools: [tool],
      }),
    );
    await collectModel(
      model,
      input({
        messages: [
          { role: 'user', content: 'Find it' },
          { role: 'assistant', content: '', toolCalls: first.toolCalls },
          { role: 'tool', toolCallId: 'call-1', content: '{}' },
        ],
        tools: [tool],
        providerState: first.providerState,
      }),
    );

    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque-thinking' },
          { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{}' }],
      },
    ]);
  });

  test('runs a Fevex agent with tool calls end to end', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const responses = [
      toolEvents(
        [{ id: 'call-1', name: 'lookup', input: {} }],
        { thinking: { thinking: 'private', signature: 'sig-1' } },
      ),
      textEvents('Found it'),
    ];
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(responses.shift()!);
      },
    })('test-model');
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Use the available tools.',
          tools: ['lookup'],
        }),
      ],
      tools: [
        defineTool({
          name: 'lookup',
          description: 'Look up a value.',
          execute() {
            return { found: true };
          },
        }),
      ],
    });

    const result = await app.runAgent('support', { input: 'Find it' });

    expect(result.output).toBe('Found it');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private', signature: 'sig-1' },
          { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: '{"found":true}',
        }],
      },
    ]);
  });

  test('passes the shared ModelGateway contract', async () => {
    const responses = [
      textEvents('{"answer":"ok"}', {
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
      toolEvents([{ id: 'call-1', name: 'lookup', input: { query: 'value' } }]),
    ];
    const model = createAnthropic({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        return ok(responses.shift()!);
      },
    })('test-model');

    await expect(testModelGateway(model, { usage: true })).resolves.toBeUndefined();
  });

  test('validates required configuration', () => {
    expect(() => createAnthropic(null as never)).toThrow('Anthropic config must be an object');
    expect(() => createAnthropic({ apiKey: ' ' })).toThrow('Anthropic apiKey cannot be empty');
    expect(() => createAnthropic({ apiKey: 1 as never })).toThrow(
      'Anthropic apiKey cannot be empty',
    );
    expect(() =>
      createAnthropic({ apiKey: 'test', baseURL: ' ' }),
    ).toThrow('Anthropic baseURL must be a non-empty string');
    expect(() =>
      createAnthropic({ apiKey: 'test', apiVersion: ' ' }),
    ).toThrow('Anthropic apiVersion must be a non-empty string');
    expect(() => createAnthropic({ apiKey: 'test' })(' ')).toThrow(
      'Anthropic modelId cannot be empty',
    );
    expect(() => createAnthropic({ apiKey: 'test' })(1 as never)).toThrow(
      'Anthropic modelId cannot be empty',
    );
    expect(() =>
      createAnthropic({
        apiKey: 'test',
        schemaPolicy: 'invalid' as 'strict',
      }),
    ).toThrow('Anthropic schemaPolicy must be "strict" or "best-effort"');
    expect(new AnthropicError('failed')).toBeInstanceOf(Error);
  });

  test('reports every unsupported strict schema construct', () => {
    const wrap = (value: JsonObject): JsonObject => ({
      type: 'object',
      properties: { value },
      required: ['value'],
      additionalProperties: false,
    });

    const cases: Array<[JsonObject, string]> = [
      [{ type: 'string' }, 'root must be an object'],
      [
        { type: 'object', properties: {}, required: [], additionalProperties: true },
        'additionalProperties',
      ],
      [
        { type: 'object', properties: [], required: [], additionalProperties: false },
        'properties: must be an object',
      ],
      [wrap({ type: 'string', items: {} }), 'array keywords require type "array"'],
      [wrap({ type: 'number', format: 'email' }), 'string keywords require type "string"'],
      [wrap({ type: 'string', pattern: '\\1' }), 'backreferences are not supported'],
      [wrap({ type: 'string', pattern: '\\bword' }), 'word boundaries are not supported'],
      [wrap({ type: 'string', format: 'uri-template' }), 'format "uri-template" is not supported'],
      [wrap({ type: 'string', enum: [{}] }), 'enum: must contain only JSON primitive values'],
      [wrap({ type: 'string', default: Number.NaN }), 'default: must be a JSON value'],
      [wrap({ type: 'array', items: { type: 'string' }, minItems: 2 }), 'minItems'],
      [wrap({ $ref: '#/$defs/Missing' }), 'unknown definition "Missing"'],
      [wrap({ oneOf: [{ type: 'string' }] }), 'oneOf: keyword is not supported'],
      [
        wrap({
          allOf: [{ $ref: '#/$defs/Node' }],
          $defs: { Node: { type: 'object', properties: {}, additionalProperties: false } },
        }),
        'allOf with $ref is not supported',
      ],
      [
        {
          type: 'object',
          properties: { value: { $ref: '#/$defs/A' } },
          required: ['value'],
          additionalProperties: false,
          $defs: {
            A: { $ref: '#/$defs/B' },
            B: { $ref: '#/$defs/A' },
          },
        },
        'recursive $ref is not supported',
      ],
    ];

    for (const [schema, expected] of cases) {
      const issue = findAnthropicSchemaIssue(schema);
      expect(issue).toBeDefined();
      if (expected) expect(issue).toContain(expected);
    }

    expect(
      findAnthropicSchemaIssue(
        {
          type: 'object',
          properties: {
            name: { type: 'string', format: 'email' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
            nested: { $ref: '#/$defs/Nested' },
          },
          required: ['name', 'tags', 'nested'],
          additionalProperties: false,
          $defs: {
            Nested: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
        },
      ),
    ).toBeUndefined();
    expect(
      findAnthropicSchemaIssue({ type: 'object', additionalProperties: false }),
    ).toBeUndefined();
  });
});

const emptyObjectSchema: JsonObject = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};
