import { describe, expect, test } from 'bun:test';
import type { ModelGenerateInput } from 'fevex';
import { testModelGateway } from 'fevex/testing';
import { createDeepSeek, DeepSeekError } from './index';

const ok = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-ds-request-id': 'req_ok' },
});

const input = (overrides: Partial<ModelGenerateInput> = {}): ModelGenerateInput => ({
  messages: [{ role: 'user', content: 'Hello' }],
  ...overrides,
});

describe('createDeepSeek', () => {
  test('builds a chat completions request from model input', async () => {
    const requests: unknown[] = [];
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        requests.push({ url: _url, init });
        return ok({
          choices: [{ message: { content: 'done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        });
      },
    })('deepseek-chat');

    const result = await model.generate(input({
      modelOptions: {
        temperature: 0,
        model: 'ignored-model',
        messages: [],
      },
    }));

    const request = requests[0] as { url: string; init: RequestInit };
    expect(request.url).toBe('https://api.deepseek.com/chat/completions');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toEqual({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    });
    expect(JSON.parse(request.init.body as string)).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0,
    });
    expect(result).toEqual({
      output: 'done',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
  });

  test('sends tools, JSON output mode and previous tool results', async () => {
    let body: unknown;
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return ok({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"query":"value"}' },
              }],
            },
          }],
        });
      },
    })('deepseek-chat');

    const result = await model.generate(input({
      messages: [
        { role: 'user', content: 'Find it' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-0', name: 'lookup', input: { query: 'old' } }] },
        { role: 'tool', name: 'lookup', toolCallId: 'call-0', content: '{"found":true}' },
      ],
      tools: [{
        name: 'lookup',
        description: 'Look up a value.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
      outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    }));

    expect(body).toEqual({
      model: 'deepseek-chat',
      messages: [
        { role: 'user', content: 'Find it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-0',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"old"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-0', content: '{"found":true}' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up a value.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      }],
      parallel_tool_calls: false,
      response_format: { type: 'json_object' },
    });
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'lookup', input: { query: 'value' } }]);
  });

  test('parses JSON output text when possible', async () => {
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () => ok({ choices: [{ message: { content: '{"answer":"done"}' } }] }),
    })('deepseek-chat');

    await expect(model.generate(input())).resolves.toEqual({ output: { answer: 'done' } });
  });

  test('preserves abort and reports HTTP failures', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedModel = createDeepSeek({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        throw new DOMException('Aborted', 'AbortError');
      },
    })('deepseek-chat');

    await expect(abortedModel.generate(input({ signal: controller.signal })))
      .rejects.toMatchObject({ cause: { name: 'AbortError' } });

    const failingModel = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () => new Response(JSON.stringify({ error: { message: 'bad request' } }), {
        status: 400,
        headers: { 'x-ds-request-id': 'req_bad' },
      }),
    })('deepseek-chat');

    await expect(failingModel.generate(input())).rejects.toMatchObject({
      name: 'DeepSeekError',
      message: 'bad request',
      status: 400,
      requestId: 'req_bad',
    });
  });

  test('rejects invalid tool arguments and empty responses', async () => {
    const invalidToolModel = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () => ok({
        choices: [{
          message: {
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{' },
            }],
          },
        }],
      }),
    })('deepseek-chat');

    await expect(invalidToolModel.generate(input())).rejects.toThrow(
      'DeepSeek tool call "lookup" returned invalid JSON arguments',
    );

    const emptyModel = createDeepSeek({
      apiKey: 'test-key',
      fetch: async () => ok({ choices: [{ message: {} }] }),
    })('deepseek-chat');

    await expect(emptyModel.generate(input())).rejects.toThrow('DeepSeek response returned no output');
  });

  test('passes the shared ModelGateway contract', async () => {
    const responses = [
      { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } },
      {
        choices: [{
          message: {
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"query":"value"}' },
            }],
          },
        }],
      },
    ];
    const model = createDeepSeek({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        return ok(responses.shift());
      },
    })('deepseek-chat');

    await expect(testModelGateway(model, { usage: true })).resolves.toBeUndefined();
  });

  test('validates required configuration', () => {
    expect(() => createDeepSeek({ apiKey: ' ' })).toThrow('DeepSeek apiKey cannot be empty');
    expect(() => createDeepSeek({ apiKey: 'test' })(' ')).toThrow('DeepSeek modelId cannot be empty');
    expect(new DeepSeekError('failed')).toBeInstanceOf(Error);
  });
});
