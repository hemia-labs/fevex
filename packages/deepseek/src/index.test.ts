import { describe, expect, test } from 'bun:test';
import {
  PROVIDER_REASONING_UNSUPPORTED,
  PROVIDER_SCHEMA_UNSUPPORTED,
  type JsonObject,
  type ModelGateway,
  type ModelInput,
  type ModelResult,
} from '@fevex/core';
import { testModelGateway } from '@fevex/core/testing';
import { createDeepSeek, DeepSeekError } from './index';

const ok = (body: unknown) =>
  new Response(toDeepSeekSSE(body), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-ds-request-id': 'req_ok' },
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

function toDeepSeekSSE(body: unknown): string {
  const response = body as {
    choices?: Array<{
      finish_reason?: unknown;
      message?: {
        content?: unknown;
        reasoning_content?: unknown;
        tool_calls?: Array<Record<string, unknown>>;
      };
    }>;
    usage?: unknown;
  };
  const choice = response.choices?.[0];
  const message = choice?.message;
  const delta = {
    ...(typeof message?.content === 'string' ? { content: message.content } : {}),
    ...(typeof message?.reasoning_content === 'string'
      ? { reasoning_content: message.reasoning_content }
      : {}),
    ...(message?.tool_calls
      ? {
          tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
        }
      : {}),
  };
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: choice?.finish_reason ?? null,
        },
      ],
    })}\n\n`,
    ...(response.usage
      ? [`data: ${JSON.stringify({ choices: [], usage: response.usage })}\n\n`]
      : []),
    'data: [DONE]\n\n',
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
      headers: { 'content-type': 'text/event-stream', 'x-ds-request-id': 'req_stream' },
    },
  );
}

describe('createDeepSeek', () => {
  test('builds a chat completions request from model input', async () => {
    const requests: unknown[] = [];
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        requests.push({ url: _url, init });
        return ok({
          choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        });
      },
    })('deepseek-chat');

    const result = await collectModel(
      model,
      input({
        modelOptions: {
          temperature: 0,
          model: 'ignored-model',
          messages: [],
          tools: [{ type: 'function' }],
          tool_choice: 'required',
          parallel_tool_calls: true,
          stream: true,
          stream_options: { include_usage: true },
        },
      }),
    );

    const request = requests[0] as { url: string; init: RequestInit };
    expect(request.url).toBe('https://api.deepseek.com/chat/completions');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toEqual({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    });
    expect(JSON.parse(request.init.body as string)).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
    });
    expect(result).toEqual({
      output: 'done',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
  });

  test('ignores null usage chunks while streaming', async () => {
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () =>
        fragmentedSSE(
          [
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }],
              usage: null,
            })}\n\n`,
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            })}\n\n`,
            'data: [DONE]\n\n',
          ].join(''),
        ),
    })('deepseek-chat');

    await expect(collectModel(model, input())).resolves.toEqual({
      output: 'done',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
  });

  test('uses the strictest output token cap', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok({
          choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
        });
      },
    })('deepseek-chat');

    await collectModel(
      model,
      input({
        maxOutputTokens: 30,
        modelOptions: { max_tokens: 50 },
      }),
    );
    await collectModel(
      model,
      input({
        maxOutputTokens: 50,
        modelOptions: { max_tokens: 20 },
      }),
    );

    expect(bodies.map(({ max_tokens }) => max_tokens)).toEqual([30, 20]);
  });

  test('sends best-effort tools and replays reasoning with tool results', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const responses = [
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              reasoning_content: 'private reasoning',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"query":"value"}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              reasoning_content: 'second reasoning',
              tool_calls: [
                {
                  id: 'call-2',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"query":"second"}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '{"answer":"found"}' },
          },
        ],
      },
    ];
    const model = createDeepSeek({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok(responses.shift());
      },
    })('deepseek-chat');

    const tool = {
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    } satisfies NonNullable<ModelInput['tools']>[number];
    const outputSchema: JsonObject = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
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
          { role: 'assistant', content: '', toolCalls: first.toolCalls },
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
      model: 'deepseek-chat',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        {
          role: 'system',
          content:
            'Respond with a JSON object matching this schema: {"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}',
        },
        { role: 'user', content: 'Find it' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look up a value.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        },
      ],
      parallel_tool_calls: false,
      response_format: { type: 'json_object' },
    });
    expect(bodies[1]?.messages).toEqual([
      {
        role: 'system',
        content: `Respond with a JSON object matching this schema: ${JSON.stringify(outputSchema)}`,
      },
      { role: 'user', content: 'Find it' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'private reasoning',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"value"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: '{"found":true}',
      },
    ]);
    expect(JSON.stringify(bodies[0])).toMatch(/\bjson\b/i);
    expect(first.toolCalls).toEqual([{ id: 'call-1', name: 'lookup', input: { query: 'value' } }]);
    expect(first.providerState).toBeDefined();
    expect(second.toolCalls).toEqual([
      { id: 'call-2', name: 'lookup', input: { query: 'second' } },
    ]);
    expect(bodies[2]?.messages).toEqual([
      {
        role: 'system',
        content: `Respond with a JSON object matching this schema: ${JSON.stringify(outputSchema)}`,
      },
      { role: 'user', content: 'Find it' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'private reasoning',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"value"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: '{"found":true}',
      },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'second reasoning',
        tool_calls: [
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"second"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-2',
        content: '{"found":true}',
      },
    ]);
    expect(third.output).toEqual({ answer: 'found' });
  });

  test('rejects strict output schemas before fetch', async () => {
    let fetchCalls = 0;
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () => {
        fetchCalls += 1;
        return ok({
          choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
        });
      },
    })('deepseek-chat');

    await expect(
      collectModel(
        model,
        input({
          outputSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'DeepSeekError',
      code: PROVIDER_SCHEMA_UNSUPPORTED,
      message: expect.stringContaining('output'),
    });
    expect(fetchCalls).toBe(0);
  });

  test('requires the beta endpoint for strict tools', async () => {
    let fetchCalls = 0;
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () => {
        fetchCalls += 1;
        return ok({});
      },
    })('deepseek-chat');

    await expect(
      collectModel(
        model,
        input({
          tools: [{ name: 'lookup' }],
        }),
      ),
    ).rejects.toMatchObject({
      code: PROVIDER_SCHEMA_UNSUPPORTED,
      message: expect.stringContaining('/beta'),
    });
    expect(fetchCalls).toBe(0);
  });

  test('sends compatible strict tools through the beta endpoint', async () => {
    let request: { url: string; body: Record<string, unknown> } | undefined;
    const model = createDeepSeek({
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com/beta/',
      fetch: async (url, init) => {
        request = {
          url: String(url),
          body: JSON.parse(init?.body as string),
        };
        return ok({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'empty', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        });
      },
    })('deepseek-chat');
    const numericSchema: JsonObject = {
      type: 'object',
      properties: {
        score: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['score'],
      additionalProperties: false,
    };

    await collectModel(
      model,
      input({
        tools: [{ name: 'empty' }, { name: 'score', inputSchema: numericSchema }],
      }),
    );

    expect(request?.url).toBe('https://api.deepseek.com/beta/chat/completions');
    expect(request?.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'empty',
          strict: true,
          parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'score',
          strict: true,
          parameters: numericSchema,
        },
      },
    ]);
  });

  test('rejects DeepSeek-incompatible strict keywords before fetch', async () => {
    let fetchCalls = 0;
    const model = createDeepSeek({
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com/beta',
      fetch: async () => {
        fetchCalls += 1;
        return ok({});
      },
    })('deepseek-chat');

    await expect(
      collectModel(
        model,
        input({
          tools: [
            {
              name: 'with-array-limit',
              inputSchema: {
                type: 'object',
                properties: {
                  values: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                  },
                },
                required: ['values'],
                additionalProperties: false,
              },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: PROVIDER_SCHEMA_UNSUPPORTED,
      message: expect.stringContaining('minItems'),
    });
    expect(fetchCalls).toBe(0);
  });

  test('uses plain text instructions for non-object best-effort output', async () => {
    let body: Record<string, unknown> | undefined;
    const model = createDeepSeek({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return ok({
          choices: [{ finish_reason: 'stop', message: { content: '"done"' } }],
        });
      },
    })('deepseek-chat');

    await collectModel(model, input({ outputSchema: { type: 'string' } }));

    expect(body?.response_format).toBeUndefined();
    expect(JSON.stringify(body?.messages)).toContain('JSON value');
  });

  test('preserves JSON-looking plain text without an output schema', async () => {
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () =>
        ok({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"answer":"done"}' },
            },
          ],
        }),
    })('deepseek-chat');

    await expect(collectModel(model, input())).resolves.toEqual({
      output: '{"answer":"done"}',
    });
  });

  test('preserves exact plain text and parses only requested structured output', async () => {
    const plainValues = ['123', 'true', 'null', '""', '  {"x":1}\n', ''];
    const plainModel = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () =>
        ok({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: plainValues.shift() },
            },
          ],
        }),
    })('deepseek-chat');

    for (const expected of ['123', 'true', 'null', '""', '  {"x":1}\n', '']) {
      await expect(collectModel(plainModel, input())).resolves.toEqual({
        output: expected,
      });
    }

    const structuredValues = ['{"answer":"done"}', '"done"', 'not-json'];
    const structuredModel = createDeepSeek({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async () =>
        ok({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: structuredValues.shift() },
            },
          ],
        }),
    })('deepseek-chat');
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
    ).rejects.toThrow('DeepSeek structured output was not valid JSON');
  });

  test('rejects incomplete, filtered and malformed tool-call responses', async () => {
    const responses = [
      {
        choices: [
          {
            finish_reason: 'length',
            message: { content: 'partial' },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: 'content_filter',
            message: { content: null },
          },
        ],
      },
      {
        choices: [
          {
            message: { content: 'legacy' },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: '',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
    ];
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () => ok(responses.shift()),
    })('deepseek-chat');

    await expect(collectModel(model, input())).rejects.toThrow('finish_reason "length"');
    await expect(collectModel(model, input())).rejects.toThrow('finish_reason "content_filter"');
    await expect(collectModel(model, input())).rejects.toThrow('invalid finish_reason');
    await expect(collectModel(model, input())).rejects.toThrow('finish_reason does not match');
    await expect(collectModel(model, input())).rejects.toThrow(
      'DeepSeek tool call returned an invalid id',
    );
  });

  test('validates provider state, tool names and message references before fetch', async () => {
    let fetchCalls = 0;
    const model = createDeepSeek({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async () => {
        fetchCalls += 1;
        return ok({
          choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
        });
      },
    })('deepseek-chat');

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

  test('maps only native reasoning efforts and rejects compatibility aliases', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createDeepSeek({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init?.body as string));
        return ok({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
      },
    })('deepseek-chat');

    await collectModel(
      model,
      input({
        modelOptions: {
          thinking: { type: 'enabled' },
          reasoning_effort: 'max',
        },
      }),
    );
    for (const reasoning of ['none', 'high'] as const) {
      await collectModel(
        model,
        input({
          reasoning,
          modelOptions: {
            thinking: { type: 'disabled' },
            reasoning_effort: 'max',
          },
        }),
      );
    }
    for (const reasoning of ['minimal', 'low', 'medium'] as const) {
      await expect(
        collectModel(
          model,
          input({
            reasoning,
          }),
        ),
      ).rejects.toMatchObject({
        code: PROVIDER_REASONING_UNSUPPORTED,
        message: expect.stringContaining('without compatibility mapping'),
      });
    }
    await expect(
      collectModel(
        model,
        input({
          modelOptions: { reasoning_effort: 'xhigh' },
        }),
      ),
    ).rejects.toMatchObject({
      code: PROVIDER_REASONING_UNSUPPORTED,
      message: expect.stringContaining('without compatibility mapping'),
    });

    expect(
      bodies.map(({ thinking, reasoning_effort }) => ({
        thinking,
        reasoning_effort,
      })),
    ).toEqual([
      { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
      { thinking: { type: 'disabled' }, reasoning_effort: undefined },
      { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
    ]);
  });

  test('preserves abort and reports HTTP failures', async () => {
    const controller = new AbortController();
    const abortReason = new Error('stop now');
    controller.abort(abortReason);
    const abortedModel = createDeepSeek({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        return ok({});
      },
    })('deepseek-chat');

    await expect(collectModel(abortedModel, input({ signal: controller.signal }))).rejects.toBe(
      abortReason,
    );

    const streamingController = new AbortController();
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    let cancelled = false;
    const streamingModel = createDeepSeek({
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
    })('deepseek-chat');
    const streamingRun = collectModel(
      streamingModel,
      input({ signal: streamingController.signal }),
    );
    await reading;
    streamingController.abort(abortReason);
    await expect(streamingRun).rejects.toBe(abortReason);
    expect(cancelled).toBe(true);

    const failingModel = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'bad request' } }), {
          status: 400,
          headers: { 'x-ds-request-id': 'req_bad' },
        }),
    })('deepseek-chat');

    await expect(collectModel(failingModel, input())).rejects.toMatchObject({
      name: 'DeepSeekError',
      message: 'bad request',
      status: 400,
      requestId: 'req_bad',
    });
  });

  test('rejects invalid tool arguments and empty responses', async () => {
    const invalidToolModel = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () =>
        ok({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{' },
                  },
                ],
              },
            },
          ],
        }),
    })('deepseek-chat');

    await expect(collectModel(invalidToolModel, input())).rejects.toThrow(
      'DeepSeek tool call "lookup" returned invalid JSON arguments',
    );

    const emptyModel = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () =>
        ok({
          choices: [{ finish_reason: 'stop', message: { content: null } }],
        }),
    })('deepseek-chat');

    await expect(collectModel(emptyModel, input())).rejects.toThrow(
      'DeepSeek response returned no output',
    );
  });

  test('reconstructs private reasoning, visible UTF-8 and fragmented tools from SSE', async () => {
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () =>
        fragmentedSSE(
          [
            ': keep-alive\r\n\r\n',
            frame({
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: 'private', content: 'hé🦊' },
                  finish_reason: null,
                },
              ],
            }),
            frame({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'look', arguments: '{"query":' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
            frame({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { name: 'up', arguments: '"value"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            frame({
              choices: [],
              usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
            }),
            'data: [DONE]\r\n\r\n',
          ].join(''),
        ),
    })('deepseek-chat');
    const events = [];

    for await (const event of model.stream(input())) events.push(event);

    expect(events[0]).toEqual({ type: 'output.delta', delta: 'hé🦊' });
    expect(events[1]).toMatchObject({
      type: 'completed',
      result: {
        output: 'hé🦊',
        toolCalls: [
          {
            id: 'call-1',
            name: 'lookup',
            input: { query: 'value' },
          },
        ],
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
    });
    expect(events.filter(({ type }) => type === 'output.delta')).not.toContainEqual(
      expect.objectContaining({ delta: 'private' }),
    );
  });

  test('requires valid choice zero and a final DONE marker', async () => {
    const invalidChoice = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () =>
        fragmentedSSE(
          `data: ${JSON.stringify({
            choices: [{ index: 1, delta: { content: 'no' }, finish_reason: 'stop' }],
          })}\n\ndata: [DONE]\n\n`,
        ),
    })('deepseek-chat');
    await expect(collectModel(invalidChoice, input())).rejects.toThrow(
      'DeepSeek stream returned an invalid choice',
    );

    const unterminated = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () =>
        fragmentedSSE(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'stop' }],
          })}\n\n`,
        ),
    })('deepseek-chat');
    await expect(collectModel(unterminated, input())).rejects.toThrow(
      'DeepSeek stream ended without [DONE]',
    );
  });

  test('passes the shared ModelGateway contract', async () => {
    const responses = [
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '{"answer":"ok"}' },
          },
        ],
        usage: { total_tokens: 1 },
      },
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"query":"value"}' },
                },
              ],
            },
          },
        ],
      },
    ];
    const model = createDeepSeek({
      apiKey: 'test-key',
      schemaPolicy: 'best-effort',
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        return ok(responses.shift());
      },
    })('deepseek-chat');

    await expect(testModelGateway(model, { usage: true })).resolves.toBeUndefined();
  });

  test('validates required configuration', () => {
    expect(() => createDeepSeek(null as never)).toThrow('DeepSeek config must be an object');
    expect(() => createDeepSeek({ apiKey: ' ' })).toThrow('DeepSeek apiKey cannot be empty');
    expect(() => createDeepSeek({ apiKey: 1 as never })).toThrow('DeepSeek apiKey cannot be empty');
    expect(() => createDeepSeek({ apiKey: 'test' })(' ')).toThrow(
      'DeepSeek modelId cannot be empty',
    );
    expect(() => createDeepSeek({ apiKey: 'test' })(1 as never)).toThrow(
      'DeepSeek modelId cannot be empty',
    );
    expect(() =>
      createDeepSeek({
        apiKey: 'test',
        schemaPolicy: 'invalid' as 'strict',
      }),
    ).toThrow('DeepSeek schemaPolicy must be "strict" or "best-effort"');
    expect(new DeepSeekError('failed')).toBeInstanceOf(Error);
  });
});
