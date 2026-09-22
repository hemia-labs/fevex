import { describe, expect, test } from 'bun:test';
import { IntegrationError } from '@fevex/core';
import { testToolProvider } from '@fevex/core/testing';
import { createMcpToolProvider } from './index';

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

describe('createMcpToolProvider', () => {
  test('negotiates tools, preserves session header and calls tools', async () => {
    const seenSessions: (string | null)[] = [];
    const provider = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: async (_url, init) => {
        const headers = new Headers(init?.headers);
        seenSessions.push(headers.get('mcp-session-id'));
        const body = JSON.parse(String(init?.body));
        if (body.method === 'initialize') {
          return json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'test', version: '1' },
            },
          }, { headers: { 'mcp-session-id': 'session-1' } });
        }
        if (body.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }
        if (body.method === 'tools/list') {
          return json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [{ name: 'lookup', description: 'Lookup.', inputSchema: { type: 'object' } }],
            },
          });
        }
        return json({
          jsonrpc: '2.0',
          id: body.id,
          result: { structuredContent: { answer: 'ok' } },
        });
      },
    });

    expect(provider.kind).toBe('mcp');
    await expect(testToolProvider(provider, {
      allowedTool: 'lookup',
      disallowedTool: 'delete',
    })).resolves.toBeUndefined();
    expect(seenSessions).toEqual([null, 'session-1', 'session-1', 'session-1']);
  });

  test('parses fragmented SSE JSON-RPC responses', async () => {
    const provider = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'initialize') {
          return json({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
          });
        }
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
        return sse([
          'id: 1\r\ndata: {"jsonrpc":"2.0",',
          `"id":${body.id},"result":{"structuredContent":{"answer":"ok"}}}\r\n\r\n`,
        ]);
      },
    });

    await expect(provider.callTool('lookup', {}, {})).resolves.toEqual({ answer: 'ok' });
  });

  test('classifies incompatible versions, missing capabilities and tool errors safely', async () => {
    const incompatible = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: async (_url, init) => json({
        jsonrpc: '2.0',
        id: JSON.parse(String(init?.body)).id,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } },
      }),
    });
    await expect(incompatible.listTools()).rejects.toMatchObject({
      code: 'MCP_VERSION_UNSUPPORTED',
      safeMessage: 'MCP protocol version is unsupported',
    });

    const noTools = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: async (_url, init) => json({
        jsonrpc: '2.0',
        id: JSON.parse(String(init?.body)).id,
        result: { protocolVersion: '2025-11-25', capabilities: {} },
      }),
    });
    await expect(noTools.listTools()).rejects.toMatchObject({
      code: 'MCP_CAPABILITY_UNSUPPORTED',
    });

    const erroring = createMcpToolProvider({
      url: 'https://mcp.test/mcp',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'initialize') {
          return json({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
          });
        }
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
        return json({
          jsonrpc: '2.0',
          id: body.id,
          result: { isError: true, content: [{ type: 'text', text: 'secret body' }] },
        });
      },
    });
    await expect(erroring.callTool('lookup', {}, {})).rejects.toBeInstanceOf(IntegrationError);
    await expect(erroring.callTool('lookup', {}, {})).rejects.toMatchObject({
      safeMessage: 'MCP tool returned an error',
    });
  });
});

function server(handle: (body: any, headers: Headers) => Response | Promise<Response>) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id,
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
    }, { headers: { 'mcp-session-id': 'session' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return handle(body, new Headers(init?.headers));
  };
}

for (const stage of ['initialize', 'notifications/initialized', 'tools/list']) {
  test(`recovers on the next call after ${stage} fails`, async () => {
    let failed = false;
    let initializations = 0;
    const base = server((body) => json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'lookup' }] } }));
    const provider = createMcpToolProvider({ url: 'https://mcp.test', fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'initialize') initializations++;
      if (body.method === stage && !failed) { failed = true; throw new Error('offline'); }
      return base(url, init);
    } });
    await expect(provider.listTools()).rejects.toMatchObject({ code: 'MCP_NETWORK_ERROR' });
    await expect(provider.listTools()).resolves.toEqual([{ name: 'lookup' }]);
    expect(initializations).toBe(stage === 'tools/list' ? 1 : 2);
  });
}

test('does not publish a session before the initialized notification completes', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let lists = 0;
  let initializations = 0;
  const base = server((body) => {
    lists++;
    return json({ jsonrpc: '2.0', id: body.id, result: { tools: [] } });
  });
  const provider = createMcpToolProvider({ url: 'https://mcp.test', fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'initialize') initializations++;
    if (body.method === 'notifications/initialized') { entered(); await gate; }
    return base(url, init);
  } });
  const first = provider.listTools();
  await started;
  const second = provider.listTools();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(lists).toBe(0);
  release();
  await Promise.all([first, second]);
  expect(initializations).toBe(1);
  expect(lists).toBe(2);
});

test('rejects identity changes before sending a session or executing a tool', async () => {
  let calls = 0;
  const provider = createMcpToolProvider({ url: 'https://mcp.test',
    headers: (ctx) => ({ authorization: String(ctx?.runId) }),
    fetch: server((body, headers) => {
      calls++;
      expect(headers.get('authorization')).toBe('alice');
      return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'alice-tool' }] } });
    }),
  });
  await provider.listTools({ runId: 'alice' });
  await expect(provider.listTools({ runId: 'bob' })).rejects.toMatchObject({ code: 'MCP_IDENTITY_CHANGED' });
  await expect(provider.callTool('alice-tool', {}, { runId: 'bob' })).rejects.toMatchObject({ code: 'MCP_IDENTITY_CHANGED' });
  expect(calls).toBe(1);
});

for (const limit of ['pages', 'tools', 'bytes', 'cursor', 'sse'] as const) {
  test(`bounds discovery ${limit} and can discover again after failure`, async () => {
    let bad = true;
    let pages = 0;
    let cancelled = false;
    const provider = createMcpToolProvider({ url: 'https://mcp.test',
      maxDiscoveryPages: 2, maxDiscoveryTools: 2, maxDiscoveryBytes: 256,
      fetch: server((body) => {
        pages++;
        if (bad && limit === 'sse') return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(257))); },
          cancel() { cancelled = true; },
        }), { headers: { 'content-type': 'text/event-stream' } });
        return json({ jsonrpc: '2.0', id: body.id, result: bad ? {
          tools: limit === 'tools' ? Array.from({ length: 3 }, () => ({ name: 'a' }))
            : limit === 'bytes' ? [{ name: 'x'.repeat(257) }] : [],
          ...(limit === 'pages' ? { nextCursor: String(pages) } : {}),
          ...(limit === 'cursor' ? { nextCursor: 'repeat' } : {}),
        } : { tools: [{ name: 'ok' }] } });
      }),
    });
    await expect(provider.listTools()).rejects.toMatchObject({ code: limit === 'cursor' ? 'MCP_CURSOR_REPEATED' : 'MCP_DISCOVERY_LIMIT' });
    expect(pages).toBeLessThanOrEqual(2);
    if (limit === 'sse') expect(cancelled).toBe(true);
    bad = false;
    await expect(provider.listTools()).resolves.toEqual([{ name: 'ok' }]);
  });
}

test('counts discovery bytes across pages and rejects invalid limits', async () => {
  let pages = 0;
  const provider = createMcpToolProvider({ url: 'https://mcp.test', maxDiscoveryBytes: 256,
    fetch: server((body) => {
      pages++;
      return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'x'.repeat(60) }], nextCursor: String(pages) } });
    }),
  });
  await expect(provider.listTools()).rejects.toMatchObject({ code: 'MCP_DISCOVERY_LIMIT' });
  expect(pages).toBe(2);
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    expect(() => createMcpToolProvider({ url: 'https://mcp.test', maxDiscoveryPages: value })).toThrow(TypeError);
  }
});
