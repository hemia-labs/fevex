import {
  compileFevexJsonSchema,
  IntegrationError,
  validateFevexJsonSchemaProfile,
  type FevexJsonSchemaProfileLimits,
  type JsonObject,
  type JsonValue,
  type ToolProvider,
  type ToolProviderContext,
  type ToolProviderTool,
} from '@fevex/core';

export type OpenApiOperationId = string;
export type OpenApiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type OpenApiAuthHeadersResolver =
  (context?: ToolProviderContext) => HeadersInit | Promise<HeadersInit>;

export interface OpenApiToolProviderOptions {
  document: JsonObject;
  baseUrl?: string | URL;
  fetch?: OpenApiFetch;
  headers?: HeadersInit | OpenApiAuthHeadersResolver;
  operations: { allow: readonly OpenApiOperationId[] };
  limits?: FevexJsonSchemaProfileLimits & {
    maxTools?: number;
    maxResponseBytes?: number;
  };
  requestTimeoutMs?: number;
}

interface Operation {
  id: string;
  method: string;
  path: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  inputValidator: ReturnType<typeof compileFevexJsonSchema>;
  outputValidator?: ReturnType<typeof compileFevexJsonSchema>;
  parameters: Parameter[];
  requestBody?: JsonObject;
}

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema: JsonObject;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_LIMIT = 1_000_000;

export function createOpenApiToolProvider(options: OpenApiToolProviderOptions): ToolProvider {
  const document = options.document;
  assertDocument(document);
  if (!options.operations || !Array.isArray(options.operations.allow) || options.operations.allow.length === 0) {
    throw error('OPENAPI_OPERATION_NOT_ALLOWED', 'validation', false, 'OpenAPI operations.allow must be non-empty');
  }
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = resolveBaseUrl(document, options.baseUrl);
  const allow = new Set(options.operations.allow);
  const operations = collectOperations(document, allow, options.limits);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.limits?.maxResponseBytes ?? DEFAULT_RESPONSE_LIMIT;

  return {
    async listTools() {
      return operations.map((operation): ToolProviderTool => ({
        name: operation.id,
        ...(operation.description ? { description: operation.description } : {}),
        inputSchema: operation.inputSchema,
        ...(operation.outputSchema ? { outputSchema: operation.outputSchema } : {}),
      }));
    },

    async callTool(name, input, context) {
      const operation = operations.find((item) => item.id === name);
      if (!operation) {
        throw error('OPENAPI_OPERATION_NOT_ALLOWED', 'validation', false, 'OpenAPI operation is not allowed');
      }
      const validInput = operation.inputValidator.validate(input) as JsonObject;
      const signal = timeoutSignal(context.signal, timeoutMs);
      try {
        const request = await buildRequest(operation, validInput, baseUrl, options.headers, context, signal.signal);
        const response = await fetchImpl(request.url, request.init);
        if (!response.ok) {
          throw error('OPENAPI_HTTP_ERROR', 'remote', response.status >= 500, 'OpenAPI HTTP request failed');
        }
        const output = await readJson(response, maxResponseBytes);
        if (operation.outputValidator) {
          try {
            return operation.outputValidator.validate(output);
          } catch (cause) {
            throw error('OPENAPI_RESPONSE_INVALID', 'remote', false, 'OpenAPI response does not match schema', cause);
          }
        }
        return output;
      } catch (cause) {
        if (cause instanceof IntegrationError) throw cause;
        if (signal.signal.aborted) {
          throw error('OPENAPI_HTTP_ERROR', 'timeout', true, 'OpenAPI request timed out', cause);
        }
        throw error('OPENAPI_HTTP_ERROR', 'network', true, 'OpenAPI request failed', cause);
      } finally {
        signal.dispose();
      }
    },
  };
}

function assertDocument(document: unknown): asserts document is JsonObject {
  if (!isRecord(document)) throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI document must be a JSON object');
  if (typeof document.openapi !== 'string' || !/^3\.1\./.test(document.openapi)) {
    throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI document must be version 3.1.x');
  }
  if (!isRecord(document.paths)) {
    throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI document paths must be an object');
  }
}

function collectOperations(
  document: JsonObject,
  allow: Set<string>,
  limits: OpenApiToolProviderOptions['limits'],
): Operation[] {
  const all: Operation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths as JsonObject)) {
    if (!isRecord(pathItem)) continue;
    const pathParameters = collectParameters(pathItem.parameters);
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      const id = operation.operationId;
      if (typeof id !== 'string' || !id.trim()) {
        if (allow.has('*')) throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI exposed operations must have operationId');
        continue;
      }
      if (!allow.has('*') && !allow.has(id)) continue;
      all.push(buildOperation(document, path, method, operation, [...pathParameters, ...collectParameters(operation.parameters)], limits));
    }
  }
  if (all.length === 0) throw error('OPENAPI_OPERATION_NOT_ALLOWED', 'validation', false, 'OpenAPI allowlist references an unknown operation');
  if (limits?.maxTools !== undefined && all.length > limits.maxTools) {
    throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI document exceeds maxTools limit');
  }
  if (!allow.has('*')) {
    const ids = new Set(all.map((operation) => operation.id));
    for (const id of allow) {
      if (!ids.has(id)) throw error('OPENAPI_OPERATION_NOT_ALLOWED', 'validation', false, 'OpenAPI allowlist references an unknown operation');
    }
  }
  return all;
}

function buildOperation(
  document: JsonObject,
  path: string,
  method: string,
  operation: JsonObject,
  parameters: Parameter[],
  limits: OpenApiToolProviderOptions['limits'],
): Operation {
  const id = operation.operationId as string;
  const requestBody = requestBodySchema(operation);
  const outputSchema = responseSchema(operation);
  const inputSchema = operationInputSchema(parameters, requestBody);
  validateSchema(inputSchema, document, true, limits);
  if (outputSchema) validateSchema(outputSchema, document, false, limits);
  return {
    id,
    method: method.toUpperCase(),
    path,
    ...(typeof operation.summary === 'string' || typeof operation.description === 'string'
      ? { description: (operation.summary as string | undefined) ?? (operation.description as string) }
      : {}),
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    inputValidator: compileFevexJsonSchema(inputSchema, { rootDocument: document, requireRootObject: true, limits }),
    ...(outputSchema ? { outputValidator: compileFevexJsonSchema(outputSchema, { rootDocument: document, limits }) } : {}),
    parameters,
    ...(requestBody ? { requestBody } : {}),
  };
}

function collectParameters(raw: unknown): Parameter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI parameters must be an array');
  return raw.map((item): Parameter => {
    if (!isRecord(item) || typeof item.name !== 'string' || !['path', 'query', 'header', 'cookie'].includes(String(item.in)) || !isRecord(item.schema)) {
      throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI parameter must include name, in and schema');
    }
    return {
      name: item.name,
      in: item.in as Parameter['in'],
      required: item.in === 'path' || item.required === true,
      schema: item.schema,
    };
  });
}

function operationInputSchema(parameters: Parameter[], body?: JsonObject): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const group of ['path', 'query', 'header', 'cookie'] as const) {
    const items = parameters.filter((parameter) => parameter.in === group);
    if (!items.length) continue;
    properties[group] = {
      type: 'object',
      properties: Object.fromEntries(items.map((parameter) => [parameter.name, parameter.schema])),
      required: items.filter((parameter) => parameter.required).map((parameter) => parameter.name),
      additionalProperties: false,
    };
    if (items.some((parameter) => parameter.required)) required.push(group);
  }
  if (body) {
    properties.body = body;
    required.push('body');
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function requestBodySchema(operation: JsonObject): JsonObject | undefined {
  if (!isRecord(operation.requestBody)) return undefined;
  const content = operation.requestBody.content;
  if (!isRecord(content)) throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI requestBody content must be an object');
  const json = content['application/json'];
  if (!isRecord(json) || !isRecord(json.schema)) {
    throw error('OPENAPI_SCHEMA_UNSUPPORTED', 'validation', false, 'OpenAPI v1 supports only application/json request bodies');
  }
  return json.schema;
}

function responseSchema(operation: JsonObject): JsonObject | undefined {
  if (!isRecord(operation.responses)) return undefined;
  const response = (operation.responses['200'] ?? operation.responses['201'] ?? operation.responses.default) as unknown;
  if (!isRecord(response)) return undefined;
  const content = response.content;
  if (content === undefined) return undefined;
  if (!isRecord(content)) throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI response content must be an object');
  const json = content['application/json'];
  if (!isRecord(json) || !isRecord(json.schema)) {
    throw error('OPENAPI_SCHEMA_UNSUPPORTED', 'validation', false, 'OpenAPI v1 supports only application/json responses');
  }
  return json.schema;
}

async function buildRequest(
  operation: Operation,
  input: JsonObject,
  baseUrl: URL,
  headersOption: OpenApiToolProviderOptions['headers'],
  context: ToolProviderContext,
  signal: AbortSignal,
) {
  const url = new URL(operation.path.replace(/\{([^}]+)\}/g, (_match, name) => {
    const value = readGroup(input, 'path')[name];
    if (value === undefined) throw error('OPENAPI_RESPONSE_INVALID', 'validation', false, 'OpenAPI path parameter is missing');
    return encodeURIComponent(String(value));
  }), baseUrl);
  for (const [key, value] of Object.entries(readGroup(input, 'query'))) appendSearch(url, key, value);
  const headers = new Headers(await resolveHeaders(headersOption, context));
  for (const [key, value] of Object.entries(readGroup(input, 'header'))) headers.set(key, String(value));
  const cookies = Object.entries(readGroup(input, 'cookie')).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  if (cookies.length) headers.set('cookie', cookies.join('; '));
  const init: RequestInit = { method: operation.method, headers, signal };
  if ('body' in input) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(input.body);
  }
  return { url, init };
}

async function readJson(response: Response, maxBytes: number): Promise<JsonValue> {
  const text = await readLimitedText(response, maxBytes);
  if (!text.trim()) return null;
  if (!(response.headers.get('content-type') ?? '').includes('json')) {
    throw error('OPENAPI_RESPONSE_INVALID', 'remote', false, 'OpenAPI response must be JSON');
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch (cause) {
    throw error('OPENAPI_RESPONSE_INVALID', 'remote', false, 'OpenAPI response JSON is invalid', cause);
  }
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw error('OPENAPI_RESPONSE_TOO_LARGE', 'remote', false, 'OpenAPI response is too large');
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

function validateSchema(schema: JsonObject, document: JsonObject, requireRootObject: boolean, limits: OpenApiToolProviderOptions['limits']) {
  try {
    validateFevexJsonSchemaProfile(schema, { rootDocument: document, requireRootObject, limits });
  } catch (cause) {
    throw error('OPENAPI_SCHEMA_UNSUPPORTED', 'validation', false, 'OpenAPI schema is not supported by Fevex JSON Schema Profile V1', cause);
  }
}

function resolveBaseUrl(document: JsonObject, baseUrl?: string | URL): URL {
  const raw = baseUrl ?? (Array.isArray(document.servers) && isRecord(document.servers[0]) ? document.servers[0].url : undefined);
  if (typeof raw !== 'string' && !(raw instanceof URL)) {
    throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI baseUrl or servers[0].url is required');
  }
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url;
  } catch (cause) {
    throw error('OPENAPI_INVALID_DOCUMENT', 'validation', false, 'OpenAPI baseUrl is invalid', cause);
  }
}

async function resolveHeaders(headers: OpenApiToolProviderOptions['headers'], context: ToolProviderContext) {
  return typeof headers === 'function' ? headers(context) : (headers ?? {});
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (parent?.aborted) controller.abort(parent.reason);
  parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function readGroup(input: JsonObject, group: string): JsonObject {
  return isRecord(input[group]) ? input[group] : {};
}

function appendSearch(url: URL, key: string, value: JsonValue) {
  if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
  else if (value !== undefined && value !== null && typeof value !== 'object') url.searchParams.set(key, String(value));
}

function error(
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
