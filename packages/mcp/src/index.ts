import {
  IntegrationError,
  type JsonObject,
  type JsonValue,
  type ToolProvider,
  type ToolProviderContext,
  type ToolProviderTool,
} from '@fevex/core';

export const FEVEX_MCP_PROTOCOL_VERSION = '2025-11-25';

export interface McpClientInfo {
  name: string;
  version: string;
}

export type McpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface McpToolProviderOptions {
  url: string | URL;
  fetch?: McpFetch;
  headers?: HeadersInit | ((context?: ToolProviderContext) => HeadersInit | Promise<HeadersInit>);
  protocolVersion?: string;
  clientInfo?: McpClientInfo;
  requestTimeoutMs?: number;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: JsonObject;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: JsonObject;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpState {
  protocolVersion: string;
  sessionId?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createMcpToolProvider(options: McpToolProviderOptions): ToolProvider {
  if (!options.url) throw new TypeError('MCP url is required');

  const endpoint = String(options.url);
  const fetchImpl = options.fetch ?? fetch;
  const requestedVersion = options.protocolVersion ?? FEVEX_MCP_PROTOCOL_VERSION;
  const clientInfo = options.clientInfo ?? { name: 'fevex', version: '0.1.0-alpha.1' };
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextId = 1;
  let state: McpState | undefined;
  let initializing: Promise<McpState> | undefined;

  const provider: ToolProvider = {
    kind: 'mcp',

    async listTools(context) {
      await ensureInitialized(context);
      const tools: ToolProviderTool[] = [];
      let cursor: string | undefined;
      do {
        const result = await request('tools/list', cursor ? { cursor } : {}, context);
        if (!isRecord(result) || !Array.isArray(result.tools)) {
          throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned invalid tools/list result');
        }
        for (const tool of result.tools) {
          if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name.trim()) continue;
          tools.push({
            name: tool.name,
            ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
            ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
            ...(isRecord(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
          });
        }
        cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      } while (cursor);
      return tools;
    },

    async callTool(name, input, context) {
      await ensureInitialized(context);
      const result = await request('tools/call', { name, arguments: input }, context);
      if (!isRecord(result)) {
        throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned invalid tools/call result');
      }
      if (result.isError === true) {
        throw integrationError('MCP_TOOL_ERROR', 'remote', false, 'MCP tool returned an error');
      }
      if (isJsonValue(result.structuredContent)) return result.structuredContent;
      if (isJsonValue(result.content)) return result.content;
      return null;
    },
  };

  async function ensureInitialized(context?: ToolProviderContext): Promise<McpState> {
    if (state) return state;
    initializing ??= (async () => {
      const response = await send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'initialize',
        params: {
          protocolVersion: requestedVersion,
          capabilities: {},
          clientInfo: clientInfo as unknown as JsonObject,
        },
      }, context, false);
      const result = response.result;
      if (!isRecord(result) || typeof result.protocolVersion !== 'string') {
        throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned invalid initialize result');
      }
      if (result.protocolVersion !== requestedVersion) {
        throw integrationError('MCP_VERSION_UNSUPPORTED', 'validation', false, 'MCP protocol version is unsupported');
      }
      if (!isRecord(result.capabilities) || !isRecord(result.capabilities.tools)) {
        throw integrationError('MCP_CAPABILITY_UNSUPPORTED', 'validation', false, 'MCP server does not expose tools capability');
      }
      state = {
        protocolVersion: result.protocolVersion,
        ...(response.sessionId ? { sessionId: response.sessionId } : {}),
      };
      await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, context, true);
      return state;
    })();
    return initializing;
  }

  async function request(
    method: string,
    params: JsonObject,
    context?: ToolProviderContext,
  ): Promise<unknown> {
    const response = await send({
      jsonrpc: '2.0',
      id: nextId++,
      method,
      params,
    }, context, true);
    return response.result;
  }

  async function send(
    message: JsonRpcRequest | JsonRpcNotification,
    context: ToolProviderContext | undefined,
    initialized: boolean,
  ): Promise<JsonRpcResponse & { sessionId?: string }> {
    const signal = timeoutSignal(context?.signal, requestTimeoutMs);
    try {
      const headers = new Headers(await resolveHeaders(options.headers, context));
      headers.set('accept', 'application/json, text/event-stream');
      headers.set('content-type', 'application/json');
      if (initialized && state?.protocolVersion) {
        headers.set('mcp-protocol-version', state.protocolVersion);
      }
      if (state?.sessionId) headers.set('mcp-session-id', state.sessionId);

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: signal.signal,
      });
      if (!response.ok) {
        throw integrationError(
          response.status === 401 || response.status === 403 ? 'MCP_AUTH_REQUIRED' : 'MCP_HTTP_ERROR',
          response.status === 401 || response.status === 403 ? 'auth' : 'network',
          response.status >= 500,
          'MCP server request failed',
        );
      }
      if (!('id' in message)) {
        return { jsonrpc: '2.0', result: undefined };
      }
      const rpc = await readJsonRpcResponse(response, message.id);
      if (rpc.error) {
        throw integrationError('MCP_REMOTE_ERROR', 'remote', false, 'MCP server returned an error');
      }
      return {
        ...rpc,
        ...(response.headers.get('mcp-session-id')
          ? { sessionId: response.headers.get('mcp-session-id')! }
          : {}),
      };
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      if (signal.signal.aborted) {
        throw integrationError('MCP_TIMEOUT', 'timeout', true, 'MCP request timed out', error);
      }
      throw integrationError('MCP_NETWORK_ERROR', 'network', true, 'MCP network request failed', error);
    } finally {
      signal.dispose();
    }
  }

  return provider;
}

async function resolveHeaders(
  headers: McpToolProviderOptions['headers'],
  context?: ToolProviderContext,
): Promise<HeadersInit> {
  return typeof headers === 'function' ? headers(context) : (headers ?? {});
}

async function readJsonRpcResponse(response: Response, id: number): Promise<JsonRpcResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    for await (const event of readSse(response)) {
      if (!event.data.trim()) continue;
      const parsed = parseJsonRpc(event.data);
      if (parsed.id === id) return parsed;
    }
    throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP SSE stream ended without a response');
  }
  if (!contentType.includes('application/json')) {
    throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned unsupported content type');
  }
  return parseJsonRpc(await response.text());
}

async function* readSse(response: Response): AsyncGenerator<{ data: string }> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    buffer = buffer.replace(/\r\n/g, '\n');
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      yield { data };
      index = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
}

function parseJsonRpc(text: string): JsonRpcResponse {
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC response');
    return parsed as unknown as JsonRpcResponse;
  } catch (error) {
    throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned invalid JSON-RPC', error);
  }
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function integrationError(
  code: string,
  category: ConstructorParameters<typeof IntegrationError>[1],
  retryable: boolean,
  safeMessage: string,
  cause?: unknown,
): IntegrationError {
  return new IntegrationError(code, category, retryable, safeMessage, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  try {
    JSON.stringify(value);
    return value === null || ['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'object';
  } catch {
    return false;
  }
}
