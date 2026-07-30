import { describe, expect, test } from 'bun:test';
import { IntegrationError, type JsonObject } from '@fevex/core';
import { testToolProvider } from '@fevex/core/testing';
import { createOpenApiToolProvider } from './index';

const document = {
  openapi: '3.1.0',
  info: { title: 'Accounts', version: '1' },
  servers: [{ url: 'https://api.test' }],
  paths: {
    '/accounts/{id}': {
      get: {
        operationId: 'getAccount',
        summary: 'Get account',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
          { name: 'include', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Account' },
              },
            },
          },
        },
      },
    },
    '/accounts': {
      post: {
        operationId: 'createAccount',
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateAccount' },
            },
          },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Account' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Account: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          status: { enum: ['active', 'paused'] },
        },
        required: ['id', 'status'],
        additionalProperties: false,
      },
      CreateAccount: {
        type: 'object',
        properties: {
          status: { enum: ['active', 'paused'] },
        },
        required: ['status'],
        additionalProperties: false,
      },
    },
  },
} as unknown as JsonObject;

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('createOpenApiToolProvider', () => {
  test('lists only allowlisted operations and passes ToolProvider contract', async () => {
    const provider = createOpenApiToolProvider({
      document,
      operations: { allow: ['getAccount'] },
      fetch: async () => json({ id: 42, status: 'active' }),
    });

    expect(provider.kind).toBe('openapi');
    await expect(testToolProvider(provider, {
      allowedTool: 'getAccount',
      disallowedTool: 'createAccount',
      input: { path: { id: 42 }, query: { include: 'status' } },
      output: { id: 42, status: 'active' },
    })).resolves.toBeUndefined();
    await expect(provider.listTools()).resolves.toEqual([{
      name: 'getAccount',
      description: 'Get account',
      inputSchema: expect.objectContaining({ type: 'object' }),
      outputSchema: { $ref: '#/components/schemas/Account' },
    }]);
  });

  test('builds path, query, headers and JSON body', async () => {
    const seen: { url?: string; method?: string; auth?: string | null; body?: string } = {};
    const provider = createOpenApiToolProvider({
      document,
      operations: { allow: ['createAccount'] },
      headers: (providerContext) => ({
        authorization: `Bearer ${providerContext?.context?.actor?.id}`,
      }),
      fetch: async (url, init) => {
        seen.url = String(url);
        seen.method = init?.method;
        seen.auth = new Headers(init?.headers).get('authorization');
        seen.body = String(init?.body);
        return json({ id: 7, status: 'active' }, { status: 201 });
      },
    });

    await expect(provider.callTool('createAccount', { body: { status: 'active' } }, {
      context: { actor: { id: 'actor-1' } },
    })).resolves.toEqual({ id: 7, status: 'active' });
    expect(seen).toEqual({
      url: 'https://api.test/accounts',
      method: 'POST',
      auth: 'Bearer actor-1',
      body: '{"status":"active"}',
    });
  });

  test('rejects invalid documents, allowlists and unsupported schemas', () => {
    expect(() => createOpenApiToolProvider({
      document: { ...document, openapi: '3.0.3' },
      operations: { allow: ['getAccount'] },
    })).toThrow('3.1.x');
    expect(() => createOpenApiToolProvider({
      document,
      operations: { allow: [] },
    })).toThrow('non-empty');
    expect(() => createOpenApiToolProvider({
      document,
      operations: { allow: ['missing'] },
    })).toThrow('unknown operation');
    expect(() => createOpenApiToolProvider({
      document: {
        ...document,
        paths: {
          '/x': {
            get: {
              operationId: 'bad',
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { type: 'object', pattern: 'x' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      operations: { allow: ['bad'] },
    })).toThrow('Profile V1');
  });

  test('returns safe IntegrationErrors for HTTP, invalid JSON, large and invalid output', async () => {
    const http = createOpenApiToolProvider({
      document,
      operations: { allow: ['getAccount'] },
      fetch: async () => json({ secret: 'body' }, { status: 500 }),
    });
    await expect(http.callTool('getAccount', { path: { id: 1 } }, {})).rejects.toMatchObject({
      code: 'OPENAPI_HTTP_ERROR',
      safeMessage: 'OpenAPI HTTP request failed',
    });

    const invalidJson = createOpenApiToolProvider({
      document,
      operations: { allow: ['getAccount'] },
      fetch: async () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    });
    await expect(invalidJson.callTool('getAccount', { path: { id: 1 } }, {})).rejects.toBeInstanceOf(IntegrationError);

    const large = createOpenApiToolProvider({
      document,
      operations: { allow: ['getAccount'] },
      limits: { maxResponseBytes: 2 },
      fetch: async () => json({ id: 1, status: 'active' }),
    });
    await expect(large.callTool('getAccount', { path: { id: 1 } }, {})).rejects.toMatchObject({
      code: 'OPENAPI_RESPONSE_TOO_LARGE',
    });

    const invalidOutput = createOpenApiToolProvider({
      document,
      operations: { allow: ['getAccount'] },
      fetch: async () => json({ id: 1, status: 'bad' }),
    });
    await expect(invalidOutput.callTool('getAccount', { path: { id: 1 } }, {})).rejects.toMatchObject({
      code: 'OPENAPI_RESPONSE_INVALID',
    });
  });

  test('respects AbortSignal', async () => {
    const provider = createOpenApiToolProvider({
      document,
      operations: { allow: ['getAccount'] },
      fetch: async (_url, init) => {
        init?.signal?.throwIfAborted();
        return json({ id: 1, status: 'active' });
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.callTool('getAccount', { path: { id: 1 } }, {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'OPENAPI_HTTP_ERROR' });
  });
});
