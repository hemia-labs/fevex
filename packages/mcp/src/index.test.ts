import { describe, expect, test } from 'bun:test';
import { IntegrationError } from '@fevex/core';
import { testToolProvider } from '@fevex/core/testing';
import { createMcpToolProvider, FEVEX_MCP_PROTOCOL_VERSION } from './index';

const PROTOCOL = FEVEX_MCP_PROTOCOL_VERSION;
const VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function sse(chunks: string[]) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function discovery(overrides: Record<string, unknown> = {}) {
  return {
    resultType: 'complete',
    supportedVersions: [PROTOCOL],
    capabilities: { tools: {} },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'test', version: '1' } },
    ...overrides,
  };
}

function server(
  handle: (body: any, headers: Headers) => Response | Promise<Response>,
  discover = discovery(),
) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    if (body.method === 'server/discover') {
      return json({ jsonrpc: '2.0', id: body.id, result: discover });
    }
    return handle(body, headers);
  };
}

describe('createMcpToolProvider', () => {
  test('discovers once, sends per-request metadata and standard headers, and calls tools', async () => {
    const requests: Array<{ method: string; body: any; headers: Headers }> = [];
    const provider = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      clientInfo: { name: 'pilot', version: '1.0.0' },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const headers = new Headers(init?.headers);
        requests.push({ method: body.method, body, headers });
        if (body.method === 'server/discover') {
          return json({ jsonrpc: '2.0', id: body.id, result: discovery() });
        }
        if (body.method === 'tools/list') {
          return json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              resultType: 'complete',
              tools: [{ name: 'lookup', description: 'Lookup.', inputSchema: { type: 'object' } }],
              ttlMs: 60_000,
              cacheScope: 'private',
            },
          });
        }
        return json({
          jsonrpc: '2.0',
          id: body.id,
          result: { resultType: 'complete', structuredContent: { answer: 'ok' } },
        });
      },
    });

    expect(provider.kind).toBe('mcp');
    await expect(testToolProvider(provider, {
      allowedTool: 'lookup',
      disallowedTool: 'delete',
    })).resolves.toBeUndefined();

    expect(requests.map(({ method }) => method)).toEqual([
      'server/discover',
      'tools/list',
      'tools/call',
    ]);
    for (const request of requests) {
      expect(request.body.params._meta).toMatchObject({
        [VERSION_META]: PROTOCOL,
        [CLIENT_INFO_META]: { name: 'pilot', version: '1.0.0' },
        [CAPABILITIES_META]: {},
      });
      expect(request.headers.get('mcp-protocol-version')).toBe(PROTOCOL);
      expect(request.headers.get('mcp-method')).toBe(request.method);
      expect(request.headers.get('mcp-session-id')).toBeNull();
    }
    expect(requests[2]?.headers.get('mcp-name')).toBe('lookup');
    expect(requests[2]?.body.params).toMatchObject({
      name: 'lookup',
      arguments: { query: 'value' },
    });
  });

  test('parses fragmented SSE JSON-RPC responses', async () => {
    const provider = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: server((body) => sse([
        'id: 1\r\ndata: {"jsonrpc":"2.0",',
        `"id":${body.id},"result":{"resultType":"complete","structuredContent":{"answer":"ok"}}}\r\n\r\n`,
      ])),
    });

    await expect(provider.callTool('lookup', {}, {})).resolves.toEqual({ answer: 'ok' });
  });

  test('rejects unsupported protocol versions with actionable supported versions', async () => {
    const incompatible = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: server(() => json({ jsonrpc: '2.0', error: { code: -32603, message: 'unreachable' } }), discovery({
        supportedVersions: ['2025-11-25'],
      })),
    });
    await expect(incompatible.listTools()).rejects.toMatchObject({
      code: 'MCP_VERSION_UNSUPPORTED',
      safeMessage: expect.stringContaining('2025-11-25'),
    });

    const versionError = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return json({
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: -32022,
            message: 'Unsupported protocol version',
            data: { supported: ['2025-11-25'], requested: PROTOCOL },
          },
        }, { status: 400 });
      },
    });
    await expect(versionError.listTools()).rejects.toMatchObject({
      code: 'MCP_VERSION_UNSUPPORTED',
      safeMessage: expect.stringContaining('2025-11-25'),
    });
  });

  test('fails clearly for legacy servers without server/discover', async () => {
    const missing = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: async () => new Response(null, { status: 404 }),
    });
    await expect(missing.listTools()).rejects.toMatchObject({
      code: 'MCP_VERSION_UNSUPPORTED',
      safeMessage: expect.stringContaining('server/discover'),
    });

    const methodNotFound = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: 'Method not found' },
        });
      },
    });
    await expect(methodNotFound.listTools()).rejects.toMatchObject({
      code: 'MCP_VERSION_UNSUPPORTED',
      safeMessage: expect.stringContaining(PROTOCOL),
    });
  });

  test('rejects missing tools capability and classifies tool errors safely', async () => {
    const noTools = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: server(() => json({ jsonrpc: '2.0', error: { code: -32603, message: 'unreachable' } }), discovery({
        capabilities: {},
      })),
    });
    await expect(noTools.listTools()).rejects.toMatchObject({
      code: 'MCP_CAPABILITY_UNSUPPORTED',
    });

    const erroring = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: server((body) => json({
        jsonrpc: '2.0',
        id: body.id,
        result: { resultType: 'complete', isError: true, content: [{ type: 'text', text: 'secret body' }] },
      })),
    });
    await expect(erroring.callTool('lookup', {}, {})).rejects.toBeInstanceOf(IntegrationError);
    await expect(erroring.callTool('lookup', {}, {})).rejects.toMatchObject({
      safeMessage: 'MCP tool returned an error',
    });
  });

  test('retries discovery after a network failure and caches success', async () => {
    let discoveries = 0;
    let failed = false;
    const provider = createMcpToolProvider({
      url: 'https://mcp.test',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'server/discover') {
          discoveries++;
          if (!failed) {
            failed = true;
            throw new Error('offline');
          }
          return json({ jsonrpc: '2.0', id: body.id, result: discovery() });
        }
        return json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', tools: [{ name: 'lookup' }] } });
      },
    });
    await expect(provider.listTools()).rejects.toMatchObject({ code: 'MCP_NETWORK_ERROR' });
    await expect(provider.listTools()).resolves.toEqual([{ name: 'lookup' }]);
    await expect(provider.listTools()).resolves.toEqual([{ name: 'lookup' }]);
    expect(discoveries).toBe(2);
  });

  test('rejects identity changes before sending a request', async () => {
    let calls = 0;
    const provider = createMcpToolProvider({
      url: 'https://mcp.test',
      headers: (context) => ({ authorization: String(context?.runId) }),
      fetch: server((body, headers) => {
        calls++;
        expect(headers.get('authorization')).toBe('alice');
        return json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', tools: [{ name: 'alice-tool' }] } });
      }),
    });
    await provider.listTools({ runId: 'alice' });
    await expect(provider.listTools({ runId: 'bob' })).rejects.toMatchObject({ code: 'MCP_IDENTITY_CHANGED' });
    await expect(provider.callTool('alice-tool', {}, { runId: 'bob' })).rejects.toMatchObject({ code: 'MCP_IDENTITY_CHANGED' });
    expect(calls).toBe(1);
  });

  test('rejects input_required results until MRTR support is added', async () => {
    const provider = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: server((body) => json({
        jsonrpc: '2.0',
        id: body.id,
        result: { resultType: 'input_required', inputRequests: [] },
      })),
    });
    await expect(provider.callTool('lookup', {}, {})).rejects.toMatchObject({
      code: 'MCP_INPUT_REQUIRED',
    });
  });

  test('base64-encodes unsafe Mcp-Name values', async () => {
    let nameHeader = '';
    const provider = createMcpToolProvider({
      url: 'https://mcp.test',
      fetch: server((body, headers) => {
        nameHeader = headers.get('mcp-name') ?? '';
        return json({
          jsonrpc: '2.0',
          id: body.id,
          result: { resultType: 'complete', structuredContent: { ok: true } },
        });
      }),
    });
    await provider.callTool('café tool', {}, {});
    expect(nameHeader.startsWith('=?base64?')).toBe(true);
    expect(nameHeader.endsWith('?=')).toBe(true);
    const decoded = atob(nameHeader.slice('=?base64?'.length, -2));
    expect(new TextDecoder().decode(Uint8Array.from(decoded, (character) => character.charCodeAt(0))))
      .toBe('café tool');
  });

  test('rejects legacy protocolVersion overrides', () => {
    expect(() => createMcpToolProvider({
      url: 'https://mcp.test',
      protocolVersion: '2025-11-25',
    })).toThrow('legacy handshake versions are not supported');
  });

  for (const limit of ['pages', 'tools', 'bytes', 'cursor', 'sse'] as const) {
    test(`bounds discovery ${limit} and can discover again after failure`, async () => {
      let bad = true;
      let pages = 0;
      let cancelled = false;
      const provider = createMcpToolProvider({
        url: 'https://mcp.test',
        maxDiscoveryPages: 2,
        maxDiscoveryTools: 2,
        maxDiscoveryBytes: 1_024,
        fetch: server((body) => {
          pages++;
          if (bad && limit === 'sse') return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(1_025))); },
            cancel() { cancelled = true; },
          }), { headers: { 'content-type': 'text/event-stream' } });
          return json({
            jsonrpc: '2.0',
            id: body.id,
            result: bad ? {
              resultType: 'complete',
              tools: limit === 'tools' ? Array.from({ length: 3 }, () => ({ name: 'a' }))
                : limit === 'bytes' ? [{ name: 'x'.repeat(1_025) }] : [],
              ...(limit === 'pages' ? { nextCursor: String(pages) } : {}),
              ...(limit === 'cursor' ? { nextCursor: 'repeat' } : {}),
            } : { resultType: 'complete', tools: [{ name: 'ok' }] },
          });
        }),
      });
      await expect(provider.listTools()).rejects.toMatchObject({
        code: limit === 'cursor' ? 'MCP_CURSOR_REPEATED' : 'MCP_DISCOVERY_LIMIT',
      });
      expect(pages).toBeLessThanOrEqual(2);
      if (limit === 'sse') expect(cancelled).toBe(true);
      bad = false;
      await expect(provider.listTools()).resolves.toEqual([{ name: 'ok' }]);
    });
  }

  test('counts discovery bytes across pages and rejects invalid limits', async () => {
    let pages = 0;
    const provider = createMcpToolProvider({
      url: 'https://mcp.test',
      maxDiscoveryBytes: 1_024,
      fetch: server((body) => {
        pages++;
        return json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            resultType: 'complete',
            tools: [{ name: 'x'.repeat(600) }],
            nextCursor: String(pages),
          },
        });
      }),
    });
    await expect(provider.listTools()).rejects.toMatchObject({ code: 'MCP_DISCOVERY_LIMIT' });
    expect(pages).toBe(2);
    for (const value of [0, -1, NaN, Infinity, 1.5]) {
      expect(() => createMcpToolProvider({ url: 'https://mcp.test', maxDiscoveryPages: value })).toThrow(TypeError);
    }
  });
});
