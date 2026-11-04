import type { IncomingMessage, ServerResponse } from 'node:http';
import { All, Controller, Get, Req, Res } from '@nestjs/common';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const MCP_VERSION = '2026-07-28';
const VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';

type NestRequest = IncomingMessage & { body?: unknown };
type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: JsonObject;
};

const tools: JsonObject[] = [
  {
    name: 'echo',
    description: 'Return the received message.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'sum',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'multiply',
    description: 'Multiply two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'slugify',
    description: 'Convert text into a URL-friendly slug.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_count',
    description: 'Count words in a text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

@Controller()
export class McpController {
  @Get()
  status() {
    return { name: 'nest-mcp', protocol: MCP_VERSION, status: 'ok', endpoint: '/mcp' };
  }

  @All('mcp')
  handleMcp(@Req() request: NestRequest, @Res() response: ServerResponse) {
    const body = request.body;
    if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      send(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }
    const message = body as JsonRpcRequest;
    if (message.id === undefined) {
      response.statusCode = 202;
      response.end();
      return;
    }
    const protocol = header(request, 'mcp-protocol-version');
    if (protocol !== MCP_VERSION) {
      send(response, 400, {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32022,
          message: 'Unsupported protocol version',
          data: { supported: [MCP_VERSION], requested: protocol ?? null },
        },
      });
      return;
    }
    const methodHeader = header(request, 'mcp-method');
    if (methodHeader !== message.method) {
      send(response, 400, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32020, message: 'Mcp-Method does not match the request body' },
      });
      return;
    }
    const meta = isRecord(message.params) ? message.params._meta : undefined;
    if (!isRecord(meta) || meta[VERSION_META] !== MCP_VERSION) {
      send(response, 400, {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32602,
          message: 'Invalid params: _meta must declare the 2026-07-28 protocol version',
        },
      });
      return;
    }

    try {
      const result = dispatch(message, request);
      send(response, 200, { jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      send(response, 200, {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32602,
          message: error instanceof Error ? error.message : 'Invalid request',
        },
      });
    }
  }
}

function dispatch(message: JsonRpcRequest, request: NestRequest): JsonObject {
  switch (message.method) {
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: [MCP_VERSION],
        capabilities: { tools: {} },
        _meta: { [SERVER_INFO_META]: { name: 'fevex-nest-mcp', version: '1.0.0' } },
        instructions: 'Local development tools for the Fevex MCP example.',
        ttlMs: 0,
        cacheScope: 'private',
      };
    case 'tools/list':
      return {
        resultType: 'complete',
        tools,
        ttlMs: 0,
        cacheScope: 'private',
      };
    case 'tools/call': {
      const params = isRecord(message.params) ? message.params : {};
      const name = typeof params.name === 'string' ? params.name : '';
      const nameHeader = header(request, 'mcp-name');
      if (nameHeader !== name) {
        throw new Error('Mcp-Name does not match the request body');
      }
      const input = isRecord(params.arguments) ? params.arguments : {};
      const output = callTool(name, input);
      return {
        resultType: 'complete',
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }
    case 'initialize':
      throw new Error('initialize is not supported; this server requires MCP 2026-07-28');
    default:
      throw new Error(`Method "${message.method}" is not supported`);
  }
}

function callTool(name: string, input: JsonObject): JsonValue {
  switch (name) {
    case 'echo':
      return { message: requiredString(input, 'message') };
    case 'sum':
      return { result: requiredNumber(input, 'a') + requiredNumber(input, 'b') };
    case 'multiply':
      return { result: requiredNumber(input, 'a') * requiredNumber(input, 'b') };
    case 'slugify': {
      const slug = requiredString(input, 'text')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return { slug };
    }
    case 'word_count': {
      const text = requiredString(input, 'text').trim();
      return { count: text ? text.split(/\s+/).length : 0 };
    }
    default:
      throw new Error(`Tool "${name}" is not supported`);
  }
}

function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`);
  return value;
}

function requiredNumber(input: JsonObject, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${key}" must be a number`);
  }
  return value;
}

function header(request: NestRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
