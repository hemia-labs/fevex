import {
  IntegrationError,
  type JsonObject,
  type JsonValue,
  type ToolProvider,
  type ToolProviderContext,
  type ToolProviderTool,
} from '@fevex/core';

export const FEVEX_MCP_PROTOCOL_VERSION = '2026-07-28';

const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

export interface McpClientInfo {
  name: string;
  version: string;
}

export interface McpElicitationRequest {
  message: string;
  requestedSchema?: JsonObject;
  mode?: 'form' | 'url';
}

export interface McpElicitationResponse {
  action: 'accept' | 'decline' | 'cancel';
  content?: JsonValue;
}

export type McpElicitationHandler = (
  request: McpElicitationRequest,
  context?: ToolProviderContext,
) => McpElicitationResponse | Promise<McpElicitationResponse>;

export interface McpNotification {
  method: string;
  params?: JsonObject;
}

export interface McpSubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}

export type McpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface McpToolProviderOptions {
  url: string | URL;
  fetch?: McpFetch;
  headers?: HeadersInit | ((context?: ToolProviderContext) => HeadersInit | Promise<HeadersInit>);
  protocolVersion?: string;
  clientInfo?: McpClientInfo;
  requestTimeoutMs?: number;
  maxDiscoveryPages?: number;
  maxDiscoveryTools?: number;
  maxDiscoveryBytes?: number;
  /** Handles MCP `elicitation/create` requests from MRTR and Tasks. */
  onElicitation?: McpElicitationHandler;
  /** Maximum consecutive input-required retries for one tool call. */
  maxInputRounds?: number;
  /** Maximum time to wait for one MCP task. */
  maxTaskWaitMs?: number;
  /** Fallback polling interval when a task does not provide one. */
  taskPollIntervalMs?: number;
  /** Opt into server-to-client change notifications. */
  subscriptions?: McpSubscriptionFilter;
  /** Receives notifications from the subscription stream. */
  onNotification?: (notification: McpNotification) => void;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: JsonObject;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpDiscovery {
  supportedVersions: string[];
  capabilities: JsonObject;
}

class McpRemoteError extends IntegrationError {
  constructor(
    readonly rpcError: NonNullable<JsonRpcResponse['error']>,
    readonly httpStatus?: number,
  ) {
    super('MCP_REMOTE_ERROR', 'remote', false, 'MCP server returned an error');
  }
}

class McpHttpError extends IntegrationError {
  constructor(readonly status: number, retryable: boolean, safeMessage: string) {
    super('MCP_HTTP_ERROR', 'network', retryable, safeMessage);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_ROUNDS = 5;
const DEFAULT_MAX_TASK_WAIT_MS = 3_600_000;
const DEFAULT_TASK_POLL_MS = 1_000;
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

export function createMcpToolProvider(options: McpToolProviderOptions): ToolProvider {
  if (!options.url) throw new TypeError('MCP url is required');

  const endpoint = String(options.url);
  const fetchImpl = options.fetch ?? fetch;
  const requestedVersion = options.protocolVersion ?? FEVEX_MCP_PROTOCOL_VERSION;
  if (requestedVersion !== FEVEX_MCP_PROTOCOL_VERSION) {
    throw new TypeError(
      `MCP protocolVersion must be "${FEVEX_MCP_PROTOCOL_VERSION}"; legacy handshake versions are not supported`,
    );
  }
  const clientInfo = options.clientInfo ?? { name: 'fevex', version: '0.1.0-alpha.1' };
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = options.maxDiscoveryPages ?? 100;
  const maxTools = options.maxDiscoveryTools ?? 1_000;
  const maxBytes = options.maxDiscoveryBytes ?? 4 * 1024 * 1024;
  const maxInputRounds = options.maxInputRounds ?? DEFAULT_MAX_INPUT_ROUNDS;
  const maxTaskWaitMs = options.maxTaskWaitMs ?? DEFAULT_MAX_TASK_WAIT_MS;
  const taskPollIntervalMs = options.taskPollIntervalMs ?? DEFAULT_TASK_POLL_MS;
  for (const value of [requestTimeoutMs, maxPages, maxTools, maxBytes, maxTaskWaitMs, taskPollIntervalMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('MCP limits must be positive safe integers');
  }
  if (!Number.isSafeInteger(maxInputRounds) || maxInputRounds < 0) {
    throw new TypeError('MCP maxInputRounds must be a non-negative safe integer');
  }
  const clientCapabilities: JsonObject = {
    ...(options.onElicitation ? { elicitation: {} } : {}),
    extensions: { [TASKS_EXTENSION]: {} },
  };
  let identity: string | undefined;
  async function connectionHeaders(context?: ToolProviderContext): Promise<Headers> {
    const headers = new Headers(await resolveHeaders(options.headers, context));
    const key = JSON.stringify([...headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
    if (identity !== undefined && identity !== key) {
      throw integrationError('MCP_IDENTITY_CHANGED', 'auth', false, 'Use a separate MCP provider for each identity or credential set');
    }
    identity = key;
    return headers;
  }
  let nextId = 1;
  let discovery: McpDiscovery | undefined;
  let discovering: Promise<McpDiscovery> | undefined;
  let subscriptionController: AbortController | undefined;
  let subscriptionStarted = false;

  const provider: ToolProvider = {
    kind: 'mcp',

    async listTools(context) {
      const headers = await connectionHeaders(context);
      await ensureDiscovered(context, headers);
      const tools: ToolProviderTool[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      const budget = { remaining: maxBytes };
      let pages = 0;
      let count = 0;
      do {
        if (++pages > maxPages) throw discoveryLimit();
        const result = await request(
          'tools/list',
          cursor ? { cursor } : {},
          context,
          headers,
          budget,
        );
        assertCompleteResult(result, 'tools/list');
        if (!isRecord(result) || !Array.isArray(result.tools)) {
          throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned invalid tools/list result');
        }
        count += result.tools.length;
        if (count > maxTools) throw discoveryLimit();
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
        if (cursor) {
          if (cursors.has(cursor)) throw integrationError('MCP_CURSOR_REPEATED', 'remote', false, 'MCP discovery repeated a cursor');
          cursors.add(cursor);
        }
      } while (cursor);
      return tools;
    },

    async callTool(name, input, context) {
      const headers = await connectionHeaders(context);
      await ensureDiscovered(context, headers);
      let inputResponses: JsonObject | undefined;
      let requestState: string | undefined;
      for (let round = 0; ; round += 1) {
        if (round > maxInputRounds) {
          throw integrationError(
            'MCP_INPUT_ROUNDS_EXCEEDED',
            'validation',
            false,
            `MCP tool exceeded ${maxInputRounds} input rounds`,
          );
        }
        const result = await request(
          'tools/call',
          {
            name,
            arguments: input,
            ...(inputResponses === undefined ? {} : { inputResponses }),
            ...(requestState === undefined ? {} : { requestState }),
          },
          context,
          headers,
        );
        if (isInputRequiredResult(result)) {
          const next = await resolveInputRequests(result, context);
          inputResponses = next.inputResponses ?? {};
          requestState = next.requestState;
          continue;
        }
        if (isTaskResult(result)) {
          const final = await resolveTask(result, context, headers);
          return toolOutput(final);
        }
        return toolOutput(result);
      }
    },

    async close() {
      subscriptionController?.abort();
      subscriptionController = undefined;
      subscriptionStarted = false;
    },
  };

  function toolOutput(result: unknown): JsonValue {
    if (!isRecord(result)) {
      throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned invalid tools/call result');
    }
    if (result.isError === true) {
      throw integrationError('MCP_TOOL_ERROR', 'remote', false, 'MCP tool returned an error');
    }
    if (isJsonValue(result.structuredContent)) return result.structuredContent;
    if (isJsonValue(result.content)) return result.content;
    return null;
  }

  async function resolveInputRequests(
    result: JsonObject,
    context: ToolProviderContext | undefined,
  ): Promise<{ inputResponses?: JsonObject; requestState?: string }> {
    const requestState = typeof result.requestState === 'string' ? result.requestState : undefined;
    const requests = isRecord(result.inputRequests) ? result.inputRequests : undefined;
    if (!requests) return requestState === undefined ? {} : { requestState };
    if (!options.onElicitation) {
      throw integrationError(
        'MCP_ELICITATION_UNSUPPORTED',
        'validation',
        false,
        'MCP server requested elicitation but no onElicitation handler is configured',
      );
    }
    const responses: JsonObject = {};
    for (const [key, request] of Object.entries(requests)) {
      if (!isRecord(request) || typeof request.method !== 'string') {
        throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned invalid input request');
      }
      if (request.method !== 'elicitation/create') {
        throw integrationError(
          'MCP_INPUT_UNSUPPORTED',
          'validation',
          false,
          `MCP input request "${request.method}" is not supported`,
        );
      }
      const params = isRecord(request.params) ? request.params : {};
      if (typeof params.message !== 'string') {
        throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP elicitation request has no message');
      }
      const response = await options.onElicitation({
        message: params.message,
        ...(isRecord(params.requestedSchema) ? { requestedSchema: params.requestedSchema } : {}),
        mode: params.mode === 'url' ? 'url' : 'form',
      }, context);
      if (
        !isRecord(response)
        || (response.action !== 'accept' && response.action !== 'decline' && response.action !== 'cancel')
      ) {
        throw integrationError(
          'MCP_ELICITATION_INVALID',
          'validation',
          false,
          'MCP elicitation handler must return accept, decline or cancel',
        );
      }
      responses[key] = response as unknown as JsonValue;
    }
    return {
      inputResponses: responses,
      ...(requestState === undefined ? {} : { requestState }),
    };
  }

  async function cancelTask(
    taskId: string,
    context: ToolProviderContext | undefined,
    headers: Headers,
  ): Promise<void> {
    await request(
      'tasks/cancel',
      { taskId },
      context === undefined ? { signal: undefined } : { ...context, signal: undefined },
      headers,
    ).catch(() => {});
  }

  async function resolveTask(
    createResult: JsonObject,
    context: ToolProviderContext | undefined,
    headers: Headers,
  ): Promise<unknown> {
    const taskId = taskIdOf(createResult);
    if (!taskId) {
      throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP task result has no taskId');
    }
    const startedAt = Date.now();
    let task: JsonObject = createResult;
    let polls = 0;
    while (true) {
      const body = isRecord(task.task) ? task.task : task;
      const status = taskStatus(task);
      if (status === 'completed') {
        if (!('result' in body)) {
          throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP task completed without a result');
        }
        return body.result;
      }
      if (status === 'failed') {
        throw integrationError('MCP_TASK_FAILED', 'remote', false, 'MCP task failed');
      }
      if (status === 'cancelled') {
        throw integrationError('MCP_TASK_CANCELLED', 'remote', false, 'MCP task was cancelled');
      }
      if (status === 'input_required') {
        const input = await resolveInputRequests(body, context);
        if (input.inputResponses === undefined) {
          throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP task requires input without requests');
        }
        await request(
          'tasks/update',
          { taskId, inputResponses: input.inputResponses },
          context,
          headers,
        );
      } else if (status !== 'working') {
        throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP task has an unknown status');
      }
      if (Date.now() - startedAt >= maxTaskWaitMs) {
        await cancelTask(taskId, context, headers);
        throw integrationError('MCP_TASK_EXPIRED', 'timeout', true, 'MCP task exceeded its wait deadline');
      }
      const requestedInterval = taskPollInterval(task);
      const interval = requestedInterval !== undefined
        && Number.isFinite(requestedInterval)
        && requestedInterval > 0
        ? Math.min(60_000, Math.max(10, requestedInterval))
        : taskPollIntervalMs;
      try {
        await sleep(interval, context?.signal);
      } catch (error) {
        if (context?.signal?.aborted) await cancelTask(taskId, context, headers);
        throw error;
      }
      const next = await request('tasks/get', { taskId }, context, headers);
      if (!isRecord(next)) {
        throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned invalid tasks/get result');
      }
      task = next;
      polls += 1;
      if (polls > 10_000) {
        await cancelTask(taskId, context, headers);
        throw integrationError('MCP_TASK_EXPIRED', 'timeout', true, 'MCP task exceeded its poll limit');
      }
    }
  }

  function startSubscription(base: Headers): void {
    if (!options.subscriptions || subscriptionStarted) return;
    subscriptionStarted = true;
    const controller = new AbortController();
    subscriptionController = controller;
    void listenSubscription(base, controller.signal)
      .catch(() => {})
      .finally(() => {
        if (subscriptionController !== controller) return;
        subscriptionController = undefined;
        subscriptionStarted = false;
      });
  }

  async function listenSubscription(base: Headers, signal: AbortSignal): Promise<void> {
    const id = nextId++;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: wireHeaders(base, 'subscriptions/listen'),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'subscriptions/listen',
        params: {
          notifications: options.subscriptions as unknown as JsonObject,
          _meta: requestMetadata(),
        },
      }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      await response.body?.cancel();
      return;
    }
    const budget = { remaining: maxBytes };
    for await (const event of readSse(response, budget, maxBytes)) {
      if (!event.data.trim()) continue;
      let notification: JsonRpcResponse;
      try {
        notification = parseJsonRpc(event.data);
      } catch {
        continue;
      }
      if (typeof notification.method !== 'string') continue;
      if (notification.method === 'notifications/subscriptions/acknowledged') continue;
      try {
        options.onNotification?.({
          method: notification.method,
          ...(isRecord(notification.params) ? { params: notification.params } : {}),
        });
      } catch {
        // A host notification callback must not terminate the subscription.
      }
    }
  }

  async function ensureDiscovered(
    context: ToolProviderContext | undefined,
    headers: Headers,
  ): Promise<McpDiscovery> {
    if (discovery) return discovery;
    discovering ??= (async () => {
      let response: JsonRpcResponse;
      try {
        response = await send({
          jsonrpc: '2.0',
          id: nextId++,
          method: 'server/discover',
          params: { _meta: requestMetadata() },
        }, context, headers);
      } catch (error) {
        throw mapDiscoveryError(error);
      }
      const result = response.result;
      assertCompleteResult(result, 'server/discover');
      if (!isRecord(result)) {
        throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned invalid server/discover result');
      }
      const supportedVersions = Array.isArray(result.supportedVersions)
        ? result.supportedVersions.filter((version): version is string => typeof version === 'string')
        : [];
      if (!supportedVersions.length) {
        throw legacyServer();
      }
      if (!supportedVersions.includes(requestedVersion)) {
        throw versionUnsupported(supportedVersions);
      }
      if (!isRecord(result.capabilities) || !isRecord(result.capabilities.tools)) {
        throw integrationError('MCP_CAPABILITY_UNSUPPORTED', 'validation', false, 'MCP server does not expose tools capability');
      }
      const found: McpDiscovery = {
        supportedVersions,
        capabilities: result.capabilities,
      };
      discovery = found;
      startSubscription(headers);
      return found;
    })().catch((error) => {
      discovering = undefined;
      throw error;
    });
    return discovering;
  }

  async function request(
    method: string,
    params: JsonObject,
    context: ToolProviderContext | undefined,
    headers: Headers,
    budget?: { remaining: number },
  ): Promise<unknown> {
    const response = await send({
      jsonrpc: '2.0',
      id: nextId++,
      method,
      params: { ...params, _meta: requestMetadata() },
    }, context, headers, budget);
    return response.result;
  }

  function requestMetadata(): JsonObject {
    return {
      [PROTOCOL_VERSION_META]: requestedVersion,
      [CLIENT_INFO_META]: clientInfo as unknown as JsonObject,
      [CLIENT_CAPABILITIES_META]: clientCapabilities,
    };
  }

  function wireHeaders(
    base: Headers,
    method: string,
    name?: string,
  ): Headers {
    const headers = new Headers(base);
    headers.set('accept', 'application/json, text/event-stream');
    headers.set('content-type', 'application/json');
    headers.set('mcp-protocol-version', requestedVersion);
    headers.set('mcp-method', method);
    if (name !== undefined) headers.set('mcp-name', encodeHeaderValue(name));
    return headers;
  }

  async function send(
    message: JsonRpcRequest,
    context: ToolProviderContext | undefined,
    baseHeaders: Headers,
    budget = { remaining: maxBytes },
  ): Promise<JsonRpcResponse> {
    const signal = timeoutSignal(context?.signal, requestTimeoutMs);
    try {
      const headers = wireHeaders(baseHeaders, message.method, requestName(message));

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: signal.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw integrationError('MCP_AUTH_REQUIRED', 'auth', false, 'MCP authentication is required');
        }
        const rpc = await readErrorResponse(response, budget);
        if (rpc?.error) throw new McpRemoteError(rpc.error, response.status);
        throw new McpHttpError(
          response.status,
          response.status >= 500,
          `MCP server request failed with HTTP ${response.status}`,
        );
      }
      const rpc = await readJsonRpcResponse(response, message.id, budget);
      if (rpc.error) throw new McpRemoteError(rpc.error, response.status);
      return rpc;
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

  function mapDiscoveryError(error: unknown): unknown {
    if (error instanceof McpRemoteError) {
      if (error.rpcError.code === -32022) {
        return versionUnsupported(supportedFromError(error.rpcError.data));
      }
      if (error.rpcError.code === -32601) return legacyServer();
    }
    if (
      error instanceof McpHttpError
      && (error.status === 400 || error.status === 404 || error.status === 405)
    ) {
      return legacyServer();
    }
    return error;
  }

  function versionUnsupported(supported: readonly string[]): IntegrationError {
    const detail = supported.length ? `; supported versions: ${supported.join(', ')}` : '';
    return integrationError(
      'MCP_VERSION_UNSUPPORTED',
      'validation',
      false,
      `MCP server does not support protocol ${requestedVersion}${detail}`,
    );
  }

  function legacyServer(): IntegrationError {
    return integrationError(
      'MCP_VERSION_UNSUPPORTED',
      'validation',
      false,
      `MCP server does not implement server/discover for protocol ${FEVEX_MCP_PROTOCOL_VERSION}; upgrade it or use a compatible MCP client`,
    );
  }

  return provider;
}

function isInputRequiredResult(value: unknown): value is JsonObject {
  return isRecord(value) && value.resultType === 'input_required';
}

function isTaskResult(value: unknown): value is JsonObject {
  return isRecord(value) && value.resultType === 'task';
}

function taskIdOf(task: JsonObject): string | undefined {
  if (typeof task.taskId === 'string' && task.taskId) return task.taskId;
  return isRecord(task.task) && typeof task.task.taskId === 'string' && task.task.taskId
    ? task.task.taskId
    : undefined;
}

function taskStatus(task: JsonObject): string | undefined {
  if (typeof task.status === 'string') return task.status;
  return isRecord(task.task) && typeof task.task.status === 'string' ? task.task.status : undefined;
}

function taskPollInterval(task: JsonObject): number | undefined {
  if (typeof task.pollIntervalMs === 'number') return task.pollIntervalMs;
  if (typeof task.pollInterval === 'number') return task.pollInterval;
  if (isRecord(task.task)) {
    if (typeof task.task.pollIntervalMs === 'number') return task.task.pollIntervalMs;
    if (typeof task.task.pollInterval === 'number') return task.task.pollInterval;
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function requestName(message: JsonRpcRequest): string | undefined {
  if (!isRecord(message.params)) return undefined;
  if (message.method === 'tools/call' && typeof message.params.name === 'string') {
    return message.params.name;
  }
  if (message.method === 'resources/read' && typeof message.params.uri === 'string') {
    return message.params.uri;
  }
  if (message.method === 'prompts/get' && typeof message.params.name === 'string') {
    return message.params.name;
  }
  return undefined;
}

/** Encode an MCP header value per the Streamable HTTP value-encoding rules. */
function encodeHeaderValue(value: string): string {
  const plain = /^[\x20-\x7E\t]*$/.test(value)
    && value.trim() === value
    && !(value.startsWith('=?base64?') && value.endsWith('?='));
  if (plain) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?base64?${btoa(binary)}?=`;
}

function supportedFromError(data: unknown): string[] {
  if (!isRecord(data) || !Array.isArray(data.supported)) return [];
  return data.supported.filter((value): value is string => typeof value === 'string');
}

function assertCompleteResult(result: unknown, method: string): void {
  if (!isRecord(result)) return;
  if (result.resultType === undefined || result.resultType === 'complete') return;
  if (result.resultType === 'input_required') {
    throw integrationError(
      'MCP_INPUT_REQUIRED',
      'validation',
      false,
      `MCP ${method} returned an input_required result; multi-round-trip requests are not supported yet`,
    );
  }
  throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, `MCP ${method} returned an unknown result type`);
}

async function resolveHeaders(
  headers: McpToolProviderOptions['headers'],
  context?: ToolProviderContext,
): Promise<HeadersInit> {
  return typeof headers === 'function' ? headers(context) : (headers ?? {});
}

async function readJsonRpcResponse(response: Response, id: number, budget: { remaining: number }): Promise<JsonRpcResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    for await (const event of readSse(response, budget)) {
      if (!event.data.trim()) continue;
      const parsed = parseJsonRpc(event.data);
      if (parsed.id === id) return parsed;
    }
    throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP SSE stream ended without a response');
  }
  if (!contentType.includes('application/json')) {
    throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP server returned unsupported content type');
  }
  let text = '';
  for await (const chunk of readText(response, budget)) text += chunk;
  const rpc = parseJsonRpc(text);
  if (rpc.id !== id) throw integrationError('MCP_INVALID_RESPONSE', 'remote', false, 'MCP response ID does not match request');
  return rpc;
}

async function readErrorResponse(
  response: Response,
  budget: { remaining: number },
): Promise<JsonRpcResponse | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    await response.body?.cancel();
    return undefined;
  }
  try {
    let text = '';
    for await (const chunk of readText(response, budget)) text += chunk;
    return parseJsonRpc(text);
  } catch {
    return undefined;
  }
}

function discoveryLimit(): IntegrationError {
  return integrationError('MCP_DISCOVERY_LIMIT', 'validation', false, 'MCP response or discovery limit exceeded');
}

async function* readText(response: Response, budget: { remaining: number }): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        budget.remaining -= value.byteLength;
        if (budget.remaining < 0) throw discoveryLimit();
      }
      yield decoder.decode(value, { stream: !done });
      if (done) break;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function* readSse(
  response: Response,
  budget: { remaining: number },
  resetBytes?: number,
): AsyncGenerator<{ data: string }> {
  let buffer = '';
  for await (const chunk of readText(response, budget)) {
    buffer += chunk;
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
      if (resetBytes !== undefined) budget.remaining = resetBytes;
      index = buffer.indexOf('\n\n');
    }
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
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
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
