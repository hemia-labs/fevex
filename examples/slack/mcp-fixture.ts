import type { JsonObject, JsonValue } from '@fevex/core';
import { FEVEX_MCP_PROTOCOL_VERSION } from '@fevex/mcp';

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: number | string | null;
  method?: unknown;
  params?: {
    name?: unknown;
    arguments?: unknown;
  };
}

interface Account {
  id: number;
  name: string;
  status: 'active' | 'paused';
  plan: 'free' | 'pro';
}

const accounts: Record<number, Account> = {
  1: { id: 1, name: 'Acme Starter', status: 'active', plan: 'free' },
  7: { id: 7, name: 'Acme Paused', status: 'paused', plan: 'free' },
  42: { id: 42, name: 'Acme Pro', status: 'active', plan: 'pro' },
  99: { id: 99, name: 'Acme Enterprise Trial', status: 'paused', plan: 'pro' },
};

const accountSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    accountId: { type: 'integer', minimum: 1 },
  },
  required: ['accountId'],
};

const listSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

/** Pure stateless MCP 2026-07-28 fixture for account data. */
export async function handleAccountsMcpRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/mcp') return new Response('not found', { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405 });

  let message: JsonRpcRequest;
  try {
    message = await request.json() as JsonRpcRequest;
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      throw new Error('Invalid request');
    }
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
      { status: 400 },
    );
  }

  const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: message.id, result });
  const fail = (code: number, text: string) => Response.json({
    jsonrpc: '2.0',
    id: message.id,
    error: { code, message: text },
  });

  switch (message.method) {
    case 'server/discover':
      return reply({
        resultType: 'complete',
        supportedVersions: [FEVEX_MCP_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: 'fevex-slack-accounts-fixture',
            version: '1.0.0',
          },
        },
      });
    case 'tools/list':
      return reply({
        resultType: 'complete',
        tools: [
          {
            name: 'accounts_list',
            description: 'List all demo accounts with status and plan.',
            inputSchema: listSchema,
          },
          {
            name: 'accounts_get',
            description: 'Look up a demo account by numeric ID through MCP.',
            inputSchema: accountSchema,
          },
        ],
        ttlMs: 0,
        cacheScope: 'private',
      });
    case 'tools/call': {
      const params = message.params;
      const tool = params?.name;
      if (tool !== 'accounts_get' && tool !== 'accounts_list') {
        return fail(-32601, 'Tool not found');
      }
      if (tool === 'accounts_list') {
        const value = { accounts: Object.values(accounts), count: Object.keys(accounts).length };
        return reply({
          resultType: 'complete',
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value as unknown as JsonValue,
        });
      }
      const input = params?.arguments;
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || typeof (input as JsonObject).accountId !== 'number'
        || !Number.isSafeInteger((input as JsonObject).accountId)
        || ((input as JsonObject).accountId as number) < 1) {
        const value = { found: false, error: 'INVALID_ACCOUNT_ID' };
        return reply({
          resultType: 'complete',
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value as unknown as JsonValue,
        });
      }
      const accountId = (input as JsonObject).accountId as number;
      const account = accounts[accountId];
      const value = account
        ? { found: true, ...account }
        : { found: false, accountId, error: 'ACCOUNT_NOT_FOUND' };
      return reply({
        resultType: 'complete',
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value as unknown as JsonValue,
      });
    }
    default:
      return fail(-32601, `Method not supported: ${message.method}`);
  }
}

/** Fetch adapter for createMcpToolProvider; no socket or network listener. */
export function accountsMcpFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return handleAccountsMcpRequest(new Request(input, init));
}
