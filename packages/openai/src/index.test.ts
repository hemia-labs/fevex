import { describe, expect, test } from 'bun:test';
import {
  PROVIDER_SCHEMA_UNSUPPORTED,
  type JsonObject,
  type ModelGateway,
  type ModelInput,
  type ModelResult,
} from '@fevex/core';
import { testModelGateway } from '@fevex/core/testing';
import { createOpenAI, OpenAIError } from './index';

const ok = (body: unknown) =>
  new Response(toOpenAISSE(body), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_ok' },
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

function toOpenAISSE(body: unknown): string {
  const response = body as {
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> }>;
  };
  const text =
    response.output
      ?.flatMap((item) => (item.type === 'message' ? (item.content ?? []) : []))
      .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text as string)
      .join('') ?? '';
  return [
    ...(text
      ? [
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: text,
          })}\n\n`,
        ]
      : []),
    `data: ${JSON.stringify({ type: 'response.completed', response: body })}\n\n`,
  ].join('');
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
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_stream' },
    },
  );
}

const textResponse = (text: unknown, extra: Record<string, unknown> = {}) => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text }],
    },
  ],
  ...extra,
});

describe('createOpenAI', () => {
  test('builds a Responses request from model input', async () => {
    const requests: unknown[] = [];
    const model = createOpenAI({
      apiKey: 'test-key',
      organization: 'org-1',
      project: 'proj-1',
      fetch: async (_url, init) => {
        requests.push({ url: _url, init });
        return ok(
          textResponse('done', {
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          }),
        );
      },
    })('test-model');

    const result = await collectModel(
      model,
      input({
        reasoning: 'low',
        modelOptions: {
          temperature: 0,
          model: 'ignored-model',
          input: 'ignored-input',
          tools: [{ type: 'web_search' }],
          tool_choice: 'required',
          parallel_tool_calls: true,
          stream: true,
          background: true,
          reasoning: { effort: 'high', summary: 'auto' },
        },
      }),
    );

    const request = requests[0] as { url: string; init: RequestInit };
    expect(request.url).toBe('https://api.openai.com/v1/responses');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toEqual({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'openai-organization': 'org-1',
      'openai-project': 'proj-1',
    });
    expect(JSON.parse(request.init.body as string)).toEqual({
      model: 'test-model',
      input: [{ role: 'user', content: 'Hello' }],
      reasoning: { effort: 'low', summary: 'auto' },
      stream: true,
      temperature: 0,
    });
    expect(result).toEqual({
      output: 'done',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
  });

  test('uses the strictest output token cap', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createOpenAI({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(textResponse('done'));
      },
    })('test-model');

    await collectModel(
      model,
      input({
        maxOutputTokens: 30,
        modelOptions: { max_output_tokens: 50 },
      }),
    );
    await collectModel(
      model,
      input({
        maxOutputTokens: 50,
        modelOptions: { max_output_tokens: 20 },
      }),
    );

    expect(bodies.map(({ max_output_tokens }) => max_output_tokens)).toEqual([30, 20]);
  });

  test('sends tools and replays native reasoning state with tool results', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const responses = [
      {
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'reason-1', summary: [] },
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'lookup',
            arguments: '{"query":"value"}',
          },
        ],
      },
      {
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'reason-2', summary: [] },
          {
            type: 'function_call',
            call_id: 'call-2',
            name: 'lookup',
            arguments: '{"query":"second"}',
          },
        ],
      },
      {
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: '{"answer":"found"}',
              },
            ],
          },
        ],
      },
    ];
    const model = createOpenAI({
      apiKey: 'test-key',
      schemaName: 'support_answer',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(responses.shift());
      },
    })('test-model');

    const tool = {
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    } satisfies NonNullable<ModelInput['tools']>[number];
    const outputSchema: JsonObject = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
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
            {
              role: 'tool',
              toolCallId: 'other-call',
              content: '{}',
            },
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
    const third = await collectModel(
      model,
      input({
        messages: [
          { role: 'user', content: 'Find it' },
          { role: 'assistant', content: '', toolCalls: first.toolCalls },
          {
            role: 'tool',
            name: 'lookup',
            toolCallId: 'call-1',
            content: '{"found":true}',
          },
          { role: 'assistant', content: '', toolCalls: second.toolCalls },
          {
            role: 'tool',
            name: 'lookup',
            toolCallId: 'call-2',
            content: '{"found":true}',
          },
        ],
        tools: [tool],
        outputSchema,
        providerState: second.providerState,
      }),
    );

    expect(bodies[0]).toEqual({
      model: 'test-model',
      stream: true,
      input: [{ role: 'user', content: 'Find it' }],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look up a value.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      parallel_tool_calls: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'support_answer',
          strict: true,
          schema: {
            ...outputSchema,
          },
        },
      },
    });
    expect(bodies[1]?.input).toEqual([
      { role: 'user', content: 'Find it' },
      { type: 'reasoning', id: 'reason-1', summary: [] },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'lookup',
        arguments: '{"query":"value"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '{"found":true}',
      },
    ]);
    expect(first.toolCalls).toEqual([{ id: 'call-1', name: 'lookup', input: { query: 'value' } }]);
    expect(first.providerState).toBeDefined();
    expect(second.toolCalls).toEqual([
      { id: 'call-2', name: 'lookup', input: { query: 'second' } },
    ]);
    expect(bodies[2]?.input).toEqual([
      { role: 'user', content: 'Find it' },
      { type: 'reasoning', id: 'reason-1', summary: [] },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'lookup',
        arguments: '{"query":"value"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '{"found":true}',
      },
      { type: 'reasoning', id: 'reason-2', summary: [] },
      {
        type: 'function_call',
        call_id: 'call-2',
        name: 'lookup',
        arguments: '{"query":"second"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-2',
        output: '{"found":true}',
      },
    ]);
    expect(third.output).toEqual({ answer: 'found' });
  });

  test('rejects unsupported strict schemas before fetch', async () => {
    let fetchCalls = 0;
    const model = createOpenAI({
      apiKey: 'test-key',
      fetch: async () => {
        fetchCalls += 1;
        return ok(textResponse('{}'));
      },
    })('test-model');
    const tooManyProperties = Object.fromEntries(
      Array.from({ length: 5_001 }, (_, index) => [`field${index}`, { type: 'string' }]),
    );
    const cases: ModelInput[] = [
      input({ outputSchema: { type: 'string' } }),
      input({
        tools: [
          {
            name: 'missing-additional-properties',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          },
        ],
      }),
      input({
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: [],
          additionalProperties: false,
        },
      }),
      input({
        outputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
          allOf: [],
        },
      }),
      input({
        outputSchema: {
          type: 'object',
          properties: tooManyProperties,
          required: Object.keys(tooManyProperties),
          additionalProperties: false,
        },
      }),
    ];

    for (const invalidInput of cases) {
      await expect(collectModel(model, invalidInput)).rejects.toMatchObject({
        name: 'OpenAIError',
        code: PROVIDER_SCHEMA_UNSUPPORTED,
      });
    }
    expect(fetchCalls).toBe(0);
  });

  test('normalizes empty strict tools and accepts OpenAI array constraints', async () => {
    let body: Record<string, unknown> | undefined;
    const model = createOpenAI({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return ok({
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call-1',
              name: 'empty',
              arguments: '{}',
            },
          ],
        });
      },
    })('test-model');

    await collectModel(
      model,
      input({
        tools: [
          { name: 'empty' },
          {
            name: 'with-array',
            inputSchema: {
              type: 'object',
              properties: {
                values: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 1,
                  maxItems: 3,
                },
                nullable: {
                  anyOf: [{ type: 'string' }, { type: 'null' }],
                },
              },
              required: ['values', 'nullable'],
              additionalProperties: false,
            },
          },
        ],
      }),
    );

    expect(body?.tools).toEqual([
      {
        type: 'function',
        name: 'empty',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        type: 'function',
        name: 'with-array',
        parameters: {
          type: 'object',
          properties: {
            values: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 3,
            },
            nullable: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
          },
          required: ['values', 'nullable'],
          additionalProperties: false,
        },
        strict: true,
      },
    ]);
  });

  test('uses JSON mode and local schema instructions in best-effort mode', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createOpenAI({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(textResponse('{"answer":"done"}'));
      },
    })('test-model');
    const objectSchema: JsonObject = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      allOf: [],
    };

    await collectModel(
      model,
      input({
        tools: [
          {
            name: 'lookup',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        outputSchema: objectSchema,
      }),
    );
    await collectModel(model, input({ outputSchema: { type: 'string' } }));

    expect(bodies[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object', properties: {} },
        strict: false,
      },
    ]);
    expect(bodies[0]?.text).toEqual({ format: { type: 'json_object' } });
    expect(JSON.stringify(bodies[0]?.input)).toContain('matching this schema');
    expect(bodies[1]?.text).toBeUndefined();
    expect(JSON.stringify(bodies[1]?.input)).toContain('JSON value');
  });

  test('preserves JSON-looking plain text without an output schema', async () => {
    const model = createOpenAI({
      apiKey: 'test-key',
      fetch: async () => ok(textResponse('{"answer":"done"}')),
    })('test-model');

    await expect(collectModel(model, input())).resolves.toEqual({
      output: '{"answer":"done"}',
    });
  });

  test('preserves exact plain text and parses only requested structured output', async () => {
    const plainValues = ['123', 'true', 'null', '""', '  {"x":1}\n', ''];
    const plainModel = createOpenAI({
      apiKey: 'test-key',
      fetch: async () =>
        ok({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: plainValues.shift() }],
            },
          ],
        }),
    })('test-model');

    for (const expected of ['123', 'true', 'null', '""', '  {"x":1}\n', '']) {
      await expect(collectModel(plainModel, input())).resolves.toEqual({
        output: expected,
      });
    }

    const structuredValues = ['{"answer":"done"}', '"done"', 'not-json'];
    const structuredModel = createOpenAI({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async () => ok(textResponse(structuredValues.shift())),
    })('test-model');
    await expect(
      collectModel(
        structuredModel,
        input({
          outputSchema: { type: 'object' },
        }),
      ),
    ).resolves.toEqual({ output: { answer: 'done' } });
    await expect(
      collectModel(
        structuredModel,
        input({
          outputSchema: { type: 'string' },
        }),
      ),
    ).resolves.toEqual({ output: 'done' });
    await expect(
      collectModel(
        structuredModel,
        input({
          outputSchema: { type: 'string' },
        }),
      ),
    ).rejects.toThrow('OpenAI structured output was not valid JSON');
  });

  test('rejects refusals, incomplete responses and malformed tool calls', async () => {
    const responses = [
      {
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'refusal', refusal: 'not allowed' }],
          },
        ],
      },
      {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'partial' }],
          },
        ],
      },
      {
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'legacy' }],
          },
        ],
      },
      {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name: 'lookup',
            arguments: '{}',
          },
        ],
      },
    ];
    const model = createOpenAI({
      apiKey: 'test-key',
      fetch: async () => ok(responses.shift()),
    })('test-model');

    await expect(collectModel(model, input())).rejects.toThrow(
      'OpenAI refused the response: not allowed',
    );
    await expect(collectModel(model, input())).rejects.toThrow(
      'OpenAI response was incomplete: max_output_tokens',
    );
    await expect(collectModel(model, input())).rejects.toThrow(
      'OpenAI response returned an invalid status',
    );
    await expect(collectModel(model, input())).rejects.toThrow(
      'OpenAI tool call returned an invalid call_id',
    );
  });

  test('validates provider state, tool names and message references before fetch', async () => {
    let fetchCalls = 0;
    const model = createOpenAI({
      apiKey: 'test-key',
      fetch: async () => {
        fetchCalls += 1;
        return ok(textResponse('done'));
      },
    })('test-model');

    await expect(
      collectModel(
        model,
        input({
          tools: [{ name: 'invalid tool' }],
        }),
      ),
    ).rejects.toThrow('[A-Za-z0-9_-]{1,64}');
    await expect(
      collectModel(
        model,
        input({
          messages: [
            {
              role: 'tool',
              toolCallId: 'missing',
              content: 'done',
            },
          ],
        }),
      ),
    ).rejects.toThrow('invalid toolCallId');
    await expect(
      collectModel(
        model,
        input({
          providerState: {},
        }),
      ),
    ).rejects.toThrow('providerState is invalid');
    await expect(
      collectModel(
        model,
        input({
          messages: [
            { role: 'user', content: 'Find it' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'lookup', input: {} }],
            },
            {
              role: 'tool',
              toolCallId: 'call-1',
              content: '{}',
            },
          ],
        }),
      ),
    ).rejects.toThrow('providerState is required');
    expect(fetchCalls).toBe(0);
  });

  test('preserves provider-only reasoning options until Fevex overrides effort', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createOpenAI({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(textResponse('done'));
      },
    })('test-model');

    await collectModel(
      model,
      input({
        modelOptions: { reasoning: { effort: 'xhigh', summary: 'auto' } },
      }),
    );
    await collectModel(
      model,
      input({
        reasoning: 'medium',
        modelOptions: { reasoning: { effort: 'xhigh', summary: 'auto' } },
      }),
    );

    expect(bodies.map(({ reasoning }) => reasoning)).toEqual([
      { effort: 'xhigh', summary: 'auto' },
      { effort: 'medium', summary: 'auto' },
    ]);
  });

  test('preserves abort and reports HTTP failures', async () => {
    const controller = new AbortController();
    const abortReason = new Error('stop now');
    controller.abort(abortReason);
    const abortedModel = createOpenAI({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        return ok(textResponse('done'));
      },
    })('test-model');

    await expect(collectModel(abortedModel, input({ signal: controller.signal }))).rejects.toBe(
      abortReason,
    );

    const streamingController = new AbortController();
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    let cancelled = false;
    const streamingModel = createOpenAI({
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

    const failingModel = createOpenAI({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'bad request' } }), {
          status: 400,
          headers: { 'x-request-id': 'req_bad' },
        }),
    })('test-model');

    await expect(collectModel(failingModel, input())).rejects.toMatchObject({
      name: 'OpenAIError',
      message: 'bad request',
      status: 400,
      requestId: 'req_bad',
    });
  });

  test('rejects invalid tool arguments and empty responses', async () => {
    const invalidToolModel = createOpenAI({
      apiKey: 'test-key',
      fetch: async () =>
        ok({
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{' }],
        }),
    })('test-model');

    await expect(collectModel(invalidToolModel, input())).rejects.toThrow(
      'OpenAI tool call "lookup" returned invalid JSON arguments',
    );

    const emptyModel = createOpenAI({
      apiKey: 'test-key',
      fetch: async () => ok({ status: 'completed', output: [] }),
    })('test-model');

    await expect(collectModel(emptyModel, input())).rejects.toThrow(
      'OpenAI response returned no output',
    );
  });

  test('streams UTF-8 deltas from arbitrarily fragmented SSE frames', async () => {
    const output = 'hé🦊';
    const response = textResponse(output);
    const model = createOpenAI({
      apiKey: 'test-key',
      fetch: async () =>
        fragmentedSSE(
          [
            ': keep-alive\r\n\r\n',
            `data: ${JSON.stringify({
              type: 'response.output_text.delta',
              delta: output,
            })}\r\n\r\n`,
            `data: ${JSON.stringify({
              type: 'response.reasoning_summary_text.delta',
              delta: 'private',
            })}\r\n\r\n`,
            `data: ${JSON.stringify({
              type: 'response.function_call_arguments.delta',
              delta: '{"private":true}',
            })}\r\n\r\n`,
            `data: ${JSON.stringify({
              type: 'response.completed',
              response,
            })}\r\n\r\n`,
          ].join(''),
        ),
    })('test-model');
    const events = [];

    for await (const event of model.stream(input())) events.push(event);

    expect(events).toEqual([
      { type: 'output.delta', delta: output },
      { type: 'completed', result: { output } },
    ]);
  });

  test('rejects invalid or unterminated OpenAI streams', async () => {
    const invalid = createOpenAI({
      apiKey: 'test-key',
      fetch: async () => fragmentedSSE('data: {\n\n'),
    })('test-model');
    await expect(collectModel(invalid, input())).rejects.toThrow(
      'OpenAI stream event was not valid JSON',
    );

    const unterminated = createOpenAI({
      apiKey: 'test-key',
      fetch: async () =>
        fragmentedSSE(
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'partial',
          })}\n\n`,
        ),
    })('test-model');
    await expect(collectModel(unterminated, input())).rejects.toThrow(
      'OpenAI stream ended without response.completed',
    );
  });

  test('passes the shared ModelGateway contract', async () => {
    const responses = [
      textResponse('{"answer":"ok"}', { usage: { total_tokens: 1 } }),
      {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'lookup',
            arguments: '{"query":"value"}',
          },
        ],
      },
    ];
    const model = createOpenAI({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        return ok(responses.shift());
      },
    })('test-model');

    await expect(testModelGateway(model, { usage: true })).resolves.toBeUndefined();
  });

  test('validates required configuration', () => {
    expect(() => createOpenAI(null as never)).toThrow('OpenAI config must be an object');
    expect(() => createOpenAI({ apiKey: ' ' })).toThrow('OpenAI apiKey cannot be empty');
    expect(() => createOpenAI({ apiKey: 1 as never })).toThrow('OpenAI apiKey cannot be empty');
    expect(() =>
      createOpenAI({
        apiKey: 'test',
        schemaName: 'invalid name',
      }),
    ).toThrow('[A-Za-z0-9_-]{1,64}');
    expect(() => createOpenAI({ apiKey: 'test' })(' ')).toThrow('OpenAI modelId cannot be empty');
    expect(() => createOpenAI({ apiKey: 'test' })(1 as never)).toThrow(
      'OpenAI modelId cannot be empty',
    );
    expect(() =>
      createOpenAI({
        apiKey: 'test',
        schemaPolicy: 'invalid' as 'strict',
      }),
    ).toThrow('OpenAI schemaPolicy must be "strict" or "best-effort"');
    expect(new OpenAIError('failed')).toBeInstanceOf(Error);
  });
});
