import type { AgentEvent, ExecutionContext, JsonValue } from '../core';
import type { Fevex } from '../fevex';
import { FevexRunError } from '../run-error';
import type {
  AgentRun,
  ResumeRunResolution,
  RunRecord,
  SessionId,
  WorkflowRun,
} from '../runtime';

export const FEVEX_HTTP_PROTOCOL_VERSION = '1';
export const FEVEX_HTTP_PROTOCOL_VERSION_HEADER = 'Fevex-Protocol-Version';
const JSON_TYPE = 'application/json';
const PROBLEM_TYPE = 'application/problem+json';
const SSE_TYPE = 'text/event-stream';

export interface StartRunHttpRequest<TInput extends JsonValue = JsonValue> {
  input: TInput;
  sessionId?: SessionId;
}

export type ResumeRunHttpRequest =
  | { type: 'approval'; approvalId: string; decision: 'approve' | 'reject' }
  | {
      type: 'tool_execution';
      toolCallId: string;
      decision: 'use_output';
      output: JsonValue;
    }
  | { type: 'tool_execution'; toolCallId: string; decision: 'retry' };

export interface FevexProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
}

export interface FevexHttpHandlerContext {
  context?: ExecutionContext;
}

export interface FevexHttpHandlerOptions {
  fevex: Fevex;
  pollIntervalMs?: number;
}

export type FevexHttpHandler = (
  request: Request,
  context?: FevexHttpHandlerContext,
) => Promise<Response>;

export function createFevexHttpHandler(options: FevexHttpHandlerOptions): FevexHttpHandler {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('pollIntervalMs must be a positive number');
  }

  return async (request, handlerContext = {}) => {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const start = path.match(/^\/v1\/agents\/([^/]+)\/runs$/);
      if (start && request.method === 'POST') {
        const body = await readJson(request);
        if (!hasOwn(body, 'input')) throw badRequest('input is required');
        const sessionId = optionalId(body.sessionId, 'sessionId');
        const run = await options.fevex.startAgent(decodeURIComponent(start[1]!), {
          input: body.input as JsonValue,
          ...(sessionId ? { sessionId } : {}),
          ...(handlerContext.context ? { context: handlerContext.context } : {}),
        });
        return json(run, 202);
      }

      const startWorkflow = path.match(/^\/v1\/workflows\/([^/]+)\/runs$/);
      if (startWorkflow && request.method === 'POST') {
        const body = await readJson(request);
        if (!hasOwn(body, 'input')) throw badRequest('input is required');
        const sessionId = optionalId(body.sessionId, 'sessionId');
        const run = await options.fevex.startWorkflow(decodeURIComponent(startWorkflow[1]!), {
          input: body.input as JsonValue,
          ...(sessionId ? { sessionId } : {}),
          ...(handlerContext.context ? { context: handlerContext.context } : {}),
        });
        return json(run, 202);
      }

      const events = path.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (events && request.method === 'GET') {
        const runId = decodeURIComponent(events[1]!);
        if (!(await options.fevex.getRun(runId))) throw notFound('RUN_NOT_FOUND', 'Run not found');
        const after = request.headers.get('last-event-id')?.trim() || undefined;
        const all = await options.fevex.listEvents(runId);
        const index = after ? all.findIndex(({ id }) => id === after) : -1;
        if (after && index < 0) throw badRequest('Last-Event-ID is not valid', 'INVALID_CURSOR');
        const initial = after ? all.slice(index + 1) : all;
        const iterator = observeEvents(
          options.fevex,
          runId,
          initial,
          after,
          pollIntervalMs,
          request.signal,
        );
        return versioned(new Response(iteratorStream(iterator), {
          headers: {
            'content-type': `${SSE_TYPE}; charset=utf-8`,
            'cache-control': 'no-cache, no-transform',
          },
        }));
      }

      const resume = path.match(/^\/v1\/runs\/([^/]+)\/resume$/);
      if (resume && request.method === 'POST') {
        const runId = decodeURIComponent(resume[1]!);
        if (!(await options.fevex.getRun(runId))) throw notFound('RUN_NOT_FOUND', 'Run not found');
        const actor = handlerContext.context?.actor;
        if (!actor?.id?.trim()) {
          throw new HttpProtocolError(401, 'ACTOR_REQUIRED', 'Authenticated actor is required');
        }
        const resolution = readResolution(await readJson(request), actor);
        return json(await options.fevex.resumeRun(runId, resolution), 202);
      }

      const run = path.match(/^\/v1\/runs\/([^/]+)$/);
      if (run && request.method === 'GET') {
        const value = await options.fevex.getRun(decodeURIComponent(run[1]!));
        if (!value) throw notFound('RUN_NOT_FOUND', 'Run not found');
        return json(value);
      }
      if (run && request.method === 'DELETE') {
        const runId = decodeURIComponent(run[1]!);
        const value = await options.fevex.getRun(runId);
        if (!value) throw notFound('RUN_NOT_FOUND', 'Run not found');
        if (value.status === 'running' || value.status === 'paused') {
          const cancelled = await options.fevex.cancelRun(runId);
          if (!cancelled && (await options.fevex.getRun(runId))?.status === value.status) {
            throw new HttpProtocolError(409, 'RUN_CONFLICT', 'Run could not be cancelled');
          }
        }
        return versioned(new Response(null, { status: 204 }));
      }

      if (start || startWorkflow || events || resume || run) {
        throw new HttpProtocolError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      }
      throw notFound('ROUTE_NOT_FOUND', 'Route not found');
    } catch (error) {
      return problem(error, url.pathname);
    }
  };
}

export interface FevexHttpClientOptions {
  baseUrl: string;
  fetch?: FevexHttpFetch;
}

export type FevexHttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ObserveRunOptions {
  after?: AgentEvent['id'];
  signal?: AbortSignal;
}

export interface FevexHttpClient {
  startRun<TInput extends JsonValue = JsonValue, TOutput = JsonValue>(
    agentName: string,
    request: StartRunHttpRequest<TInput>,
  ): Promise<AgentRun<TOutput>>;
  startWorkflow<TInput extends JsonValue = JsonValue, TOutput = JsonValue>(
    workflowName: string,
    request: StartRunHttpRequest<TInput>,
  ): Promise<WorkflowRun<TOutput>>;
  getRun<TOutput = JsonValue>(runId: string): Promise<RunRecord<TOutput>>;
  observeRun(runId: string, options?: ObserveRunOptions): AsyncIterable<AgentEvent>;
  resumeRun<TOutput = JsonValue>(
    runId: string,
    request: ResumeRunHttpRequest,
  ): Promise<RunRecord<TOutput>>;
  cancelRun(runId: string): Promise<void>;
}

export class FevexHttpError extends Error {
  readonly name = 'FevexHttpError';

  constructor(readonly problem: FevexProblemDetails) {
    super(problem.detail ?? problem.title);
  }

  get status() {
    return this.problem.status;
  }

  get code() {
    return this.problem.code;
  }
}

export function createFevexHttpClient(options: FevexHttpClientOptions): FevexHttpClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetcher: FevexHttpFetch = options.fetch ?? globalThis.fetch;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(`${baseUrl}${path}`, init);
    await assertResponse(response, JSON_TYPE);
    return response.json() as Promise<T>;
  };

  return {
    startRun(agentName, body) {
      return request(`/v1/agents/${encodeURIComponent(agentName)}/runs`, jsonInit('POST', body));
    },
    startWorkflow(workflowName, body) {
      return request(
        `/v1/workflows/${encodeURIComponent(workflowName)}/runs`,
        jsonInit('POST', body),
      );
    },
    getRun(runId) {
      return request(`/v1/runs/${encodeURIComponent(runId)}`);
    },
    observeRun(runId, observeOptions = {}) {
      return {
        async *[Symbol.asyncIterator]() {
          const response = await fetcher(
            `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`,
            {
              headers: observeOptions.after
                ? { 'last-event-id': observeOptions.after }
                : undefined,
              signal: observeOptions.signal,
            },
          );
          await assertResponse(response, SSE_TYPE);
          if (!response.body) throw new TypeError('Fevex event response has no body');
          yield* parseEventStream(response.body);
        },
      };
    },
    resumeRun(runId, body) {
      return request(`/v1/runs/${encodeURIComponent(runId)}/resume`, jsonInit('POST', body));
    },
    async cancelRun(runId) {
      const response = await fetcher(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
        method: 'DELETE',
      });
      await assertResponse(response);
    },
  };
}

async function* observeEvents(
  fevex: Fevex,
  runId: string,
  initial: AgentEvent[],
  after: string | undefined,
  pollIntervalMs: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  let pending = initial;
  let cursor = after;
  let closedEmptyReads = 0;

  while (!signal.aborted) {
    for (const event of pending) {
      cursor = event.id;
      yield encoder.encode(formatEvent(event));
    }

    const run = await fevex.getRun(runId);
    if (!run) return;
    const closed = run.status !== 'running';
    if (closed && pending.length === 0) {
      closedEmptyReads += 1;
      if (closedEmptyReads >= 2) return;
    } else {
      closedEmptyReads = 0;
    }

    await wait(pollIntervalMs, signal);
    if (signal.aborted) return;
    pending = await fevex.listEvents(runId, cursor ? { after: cursor } : undefined);
  }
}

function iteratorStream(iterator: AsyncGenerator<Uint8Array>) {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = findBoundary(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield JSON.parse(data) as AgentEvent;
        boundary = findBoundary(buffer);
      }
      if (done) {
        if (buffer.trim()) throw new TypeError('Fevex event stream ended with an incomplete frame');
        finished = true;
        return;
      }
    }
  } finally {
    if (!finished) await reader.cancel();
    reader.releaseLock();
  }
}

function findBoundary(value: string) {
  const lf = value.indexOf('\n\n');
  const crlf = value.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return undefined;
  return crlf >= 0 && (lf < 0 || crlf < lf)
    ? { index: crlf, length: 4 }
    : { index: lf, length: 2 };
}

function formatEvent(event: AgentEvent) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function readResolution(
  body: Record<string, unknown>,
  actor: NonNullable<ExecutionContext['actor']>,
): ResumeRunResolution {
  if (
    body.type === 'approval'
    && typeof body.approvalId === 'string'
    && (body.decision === 'approve' || body.decision === 'reject')
  ) {
    return { type: 'approval', approvalId: body.approvalId, decision: body.decision, actor };
  }
  if (
    body.type === 'tool_execution'
    && typeof body.toolCallId === 'string'
    && body.decision === 'retry'
  ) {
    return { type: 'tool_execution', toolCallId: body.toolCallId, decision: 'retry', actor };
  }
  if (
    body.type === 'tool_execution'
    && typeof body.toolCallId === 'string'
    && body.decision === 'use_output'
    && hasOwn(body, 'output')
  ) {
    return {
      type: 'tool_execution',
      toolCallId: body.toolCallId,
      decision: 'use_output',
      output: body.output as JsonValue,
      actor,
    };
  }
  throw badRequest('Invalid run resolution');
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().includes(JSON_TYPE)) {
    throw new HttpProtocolError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json');
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function optionalId(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${name} must be a string`);
  return value.trim();
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': JSON_TYPE },
    body: JSON.stringify(body),
  };
}

function json(value: unknown, status = 200) {
  return versioned(Response.json(value, { status, headers: { 'content-type': JSON_TYPE } }));
}

function versioned(response: Response) {
  response.headers.set(FEVEX_HTTP_PROTOCOL_VERSION_HEADER, FEVEX_HTTP_PROTOCOL_VERSION);
  return response;
}

async function assertResponse(response: Response, contentType?: string) {
  const version = response.headers.get(FEVEX_HTTP_PROTOCOL_VERSION_HEADER);
  if (version !== FEVEX_HTTP_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported Fevex HTTP protocol version "${version ?? 'missing'}"`);
  }
  if (!response.ok) {
    if (!response.headers.get('content-type')?.includes(PROBLEM_TYPE)) {
      throw new TypeError(`Expected ${PROBLEM_TYPE} response`);
    }
    const value = await response.json().catch(() => undefined);
    if (!isProblemDetails(value)) throw new TypeError('Invalid Fevex Problem Details response');
    throw new FevexHttpError(value);
  }
  if (contentType && !response.headers.get('content-type')?.includes(contentType)) {
    throw new TypeError(`Expected ${contentType} response`);
  }
}

function isProblemDetails(value: unknown): value is FevexProblemDetails {
  if (!value || typeof value !== 'object') return false;
  const problem = value as Partial<FevexProblemDetails>;
  return typeof problem.type === 'string'
    && typeof problem.title === 'string'
    && typeof problem.status === 'number'
    && typeof problem.code === 'string'
    && (problem.detail === undefined || typeof problem.detail === 'string')
    && (problem.instance === undefined || typeof problem.instance === 'string');
}

class HttpProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function badRequest(message: string, code = 'INVALID_REQUEST') {
  return new HttpProtocolError(400, code, message);
}

function notFound(code: string, message: string) {
  return new HttpProtocolError(404, code, message);
}

function problem(error: unknown, instance: string) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let title = 'Internal Server Error';
  let detail: string | undefined;

  if (error instanceof HttpProtocolError) {
    ({ status, code } = error);
    title = error.message;
    detail = error.message;
  } else if (error instanceof FevexRunError) {
    code = error.code;
    status = error.code === 'AGENT_NOT_FOUND' || error.code === 'SESSION_NOT_FOUND'
      ? 404
      : error.code === 'APPROVAL_INVALID'
        ? 400
        : error.code === 'POLICY_DENIED'
          ? 403
        : 409;
    title = status === 404
      ? 'Not Found'
      : status === 400
        ? 'Bad Request'
        : status === 403
          ? 'Forbidden'
          : 'Conflict';
    detail = error.message;
  }

  const value: FevexProblemDetails = {
    type: `urn:fevex:problem:${code.toLowerCase()}`,
    title,
    status,
    code,
    ...(detail ? { detail } : {}),
    instance,
  };
  return versioned(new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': PROBLEM_TYPE },
  }));
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}
