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
