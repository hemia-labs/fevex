import { describe, expect, test } from 'bun:test';
import type { ModelGenerateInput } from 'fevex';
import { testModelGateway } from 'fevex/testing';
import { createOpenAI, OpenAIError } from './index';

const ok = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_ok' },
});

const input = (overrides: Partial<ModelGenerateInput> = {}): ModelGenerateInput => ({
  messages: [{ role: 'user', content: 'Hello' }],
  ...overrides,
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
        return ok({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        });
      },
    })('test-model');

    const result = await model.generate(input({
      reasoning: 'low',
      modelOptions: {
        temperature: 0,
        model: 'ignored-model',
        input: 'ignored-input',
      },
    }));

    const request = requests[0] as { url: string; init: RequestInit };
    expect(request.url).toBe('https://api.openai.com/v1/responses');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toEqual({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
      'openai-organization': 'org-1',
      'openai-project': 'proj-1',
    });
    expect(JSON.parse(request.init.body as string)).toEqual({
      model: 'test-model',
      input: [{ role: 'user', content: 'Hello' }],
      reasoning: { effort: 'low' },
      temperature: 0,
    });
    expect(result).toEqual({
      output: 'done',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
  });

  test('sends tools, structured output and previous tool results', async () => {
    let body: unknown;
    const model = createOpenAI({
      apiKey: 'test-key',
      schemaName: 'support_answer',
      fetch: async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return ok({ output: [{ type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"query":"value"}' }] });
      },
    })('test-model');

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
      model: 'test-model',
      input: [
        { role: 'user', content: 'Find it' },
        { role: 'assistant', content: '' },
        { type: 'function_call', call_id: 'call-0', name: 'lookup', arguments: '{"query":"old"}' },
        { type: 'function_call_output', call_id: 'call-0', output: '{"found":true}' },
      ],
      tools: [{
        type: 'function',
        name: 'lookup',
        description: 'Look up a value.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        strict: true,
      }],
      parallel_tool_calls: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'support_answer',
          strict: true,
          schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
        },
      },
    });
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'lookup', input: { query: 'value' } }]);
  });

  test('parses JSON output text when possible', async () => {
    const model = createOpenAI({
      apiKey: 'test-key',
      fetch: async () => ok({ output_text: '{"answer":"done"}' }),
    })('test-model');

    await expect(model.generate(input())).resolves.toEqual({ output: { answer: 'done' } });
  });

  test('preserves abort and reports HTTP failures', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new DOMException('Aborted', 'AbortError');
    const abortedModel = createOpenAI({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        throw abortError;
      },
    })('test-model');

    await expect(abortedModel.generate(input({ signal: controller.signal })))
      .rejects.toMatchObject({ cause: { name: 'AbortError' } });

    const failingModel = createOpenAI({
      apiKey: 'test-key',
      fetch: async () => new Response(JSON.stringify({ error: { message: 'bad request' } }), {
        status: 400,
        headers: { 'x-request-id': 'req_bad' },
      }),
    })('test-model');

    await expect(failingModel.generate(input())).rejects.toMatchObject({
      name: 'OpenAIError',
      message: 'bad request',
      status: 400,
      requestId: 'req_bad',
    });
  });

  test('rejects invalid tool arguments and empty responses', async () => {
    const invalidToolModel = createOpenAI({
      apiKey: 'test-key',
      fetch: async () => ok({ output: [{ type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{' }] }),
    })('test-model');

    await expect(invalidToolModel.generate(input())).rejects.toThrow(
      'OpenAI tool call "lookup" returned invalid JSON arguments',
    );

    const emptyModel = createOpenAI({
      apiKey: 'test-key',
      fetch: async () => ok({ output: [] }),
    })('test-model');

    await expect(emptyModel.generate(input())).rejects.toThrow('OpenAI response returned no output');
  });

  test('passes the shared ModelGateway contract', async () => {
    const responses = [
      { output_text: 'ok', usage: { total_tokens: 1 } },
      { output: [{ type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"query":"value"}' }] },
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
    expect(() => createOpenAI({ apiKey: ' ' })).toThrow('OpenAI apiKey cannot be empty');
    expect(() => createOpenAI({ apiKey: 'test' })(' ')).toThrow('OpenAI modelId cannot be empty');
    expect(new OpenAIError('failed')).toBeInstanceOf(Error);
  });
});
