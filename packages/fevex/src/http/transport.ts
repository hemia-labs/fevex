import type { AgentEvent, ExecutionContext, JsonValue } from '../core';
import {
  ArtifactError,
  type ArtifactDescriptor,
  type ArtifactStoreContext,
} from '../artifacts';
import type { Fevex } from '../fevex';
import { MAX_DEADLINE_MS } from '../internal/run-support';
import type { ReasoningEffort } from '../models';
import { FevexRunError, type FevexRunErrorCode } from '../run-error';
import type { ResumeRunResolution, RunRecord } from '../runtime';
import {
  FEVEX_HTTP_PROTOCOL_VERSION,
  FEVEX_HTTP_PROTOCOL_VERSION_HEADER,
  type FevexArtifactAccess,
  type FevexHttpAccess,
  type FevexHttpHandler,
  type FevexHttpHandlerOptions,
  type FevexProblemDetails,
} from './protocol';

const JSON_TYPE = 'application/json';
const PROBLEM_TYPE = 'application/problem+json';
const SSE_TYPE = 'text/event-stream';
const FEVEX_RUN_ERROR_CODES = new Set<FevexRunErrorCode>([
  'INVALID_CURSOR',
  'AGENT_NOT_FOUND',
  'WORKFLOW_NOT_FOUND',
  'TEAM_NOT_FOUND',
  'MODEL_NOT_FOUND',
  'SESSION_NOT_FOUND',
  'DURABLE_STORE_REQUIRED',
  'RUN_CONFLICT',
  'RUN_NOT_RESUMABLE',
  'RUN_NOT_RECOVERABLE',
  'CHECKPOINT_UNSUPPORTED',
  'RUN_DEFINITION_CHANGED',
  'POLICY_DENIED',
  'ADMISSION_DENIED',
  'RUNTIME_CLOSED',
  'CREDENTIAL_NOT_FOUND',
  'SANDBOX_REQUIRED',
  'ELICITATION_INVALID',
  'APPROVAL_INVALID',
  'RUN_PAUSED',
  'TOOL_EXECUTION_UNKNOWN',
]);

/** Exposes a Fevex instance through the versioned HTTP protocol. */
export function createFevexHttpHandler(options: FevexHttpHandlerOptions): FevexHttpHandler {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const eventPageSize = options.eventPageSize ?? 100;
  const maxConnections = options.maxConnections;
  if (!Number.isSafeInteger(eventPageSize) || eventPageSize < 1 || eventPageSize > 1000) {
    throw new TypeError('eventPageSize must be an integer between 1 and 1000');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('pollIntervalMs must be a positive number');
  }
  if (maxConnections !== undefined && (!Number.isSafeInteger(maxConnections) || maxConnections < 1)) {
    throw new TypeError('maxConnections must be a positive safe integer');
  }
  let activeConnections = 0;

  const authorize = async (access: FevexHttpAccess) => {
    if (options.authorize && !(await options.authorize(access))) {
      throw new HttpProtocolError(403, 'FORBIDDEN', 'Forbidden');
    }
  };
  const authorizeArtifact = async (access: FevexArtifactAccess) => {
    if (options.authorizeArtifact && !(await options.authorizeArtifact(access))) {
      throw new HttpProtocolError(403, 'FORBIDDEN', 'Forbidden');
    }
  };

  return async (request, handlerContext = {}) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const commitStart = async (run: RunRecord) => {
      try {
        await options.onRunStarted?.(run, handlerContext.context);
      } catch (error) {
        await options.fevex.cancelRun(run.id).catch(() => {});
        throw error;
      }
    };

    try {
      const start = path.match(/^\/v1\/agents\/([^/]+)\/runs$/);
      if (start && request.method === 'POST') {
        const body = await readJson(request);
        if (!hasOwn(body, 'input')) throw badRequest('input is required');
        const name = decodeURIComponent(start[1]!);
        const sessionId = optionalId(body.sessionId, 'sessionId');
        const model = optionalId(body.model, 'model');
        const reasoning = optionalReasoning(body.reasoning);
        const deadlineMs = optionalDeadline(body.deadlineMs, 'deadlineMs');
        await authorize({
          action: 'start',
          kind: 'agent',
          name,
          sessionId,
          context: handlerContext.context,
        });
        const run = await options.fevex.startAgent(name, {
          input: body.input as JsonValue,
          ...(model ? { model } : {}),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
          ...(sessionId ? { sessionId } : {}),
          ...(handlerContext.context ? { context: handlerContext.context } : {}),
        });
        await commitStart(run);
        return json(run, 202);
      }

      const startWorkflow = path.match(/^\/v1\/workflows\/([^/]+)\/runs$/);
      if (startWorkflow && request.method === 'POST') {
        const body = await readJson(request);
        if (!hasOwn(body, 'input')) throw badRequest('input is required');
        const name = decodeURIComponent(startWorkflow[1]!);
        const sessionId = optionalId(body.sessionId, 'sessionId');
        const model = optionalId(body.model, 'model');
        const reasoning = optionalReasoning(body.reasoning);
        const deadlineMs = optionalDeadline(body.deadlineMs, 'deadlineMs');
        await authorize({
          action: 'start',
          kind: 'workflow',
          name,
          sessionId,
          context: handlerContext.context,
        });
        const run = await options.fevex.startWorkflow(name, {
          input: body.input as JsonValue,
          ...(model ? { model } : {}),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
          ...(sessionId ? { sessionId } : {}),
          ...(handlerContext.context ? { context: handlerContext.context } : {}),
        });
        await commitStart(run);
        return json(run, 202);
      }
      const startTeam = path.match(/^\/v1\/teams\/([^/]+)\/runs$/);
      if (startTeam && request.method === 'POST') {
        const body = await readJson(request);
        if (!hasOwn(body, 'input')) throw badRequest('Run input is required');
        const name = decodeURIComponent(startTeam[1]!);
        const sessionId = optionalId(body.sessionId, 'sessionId');
        const model = optionalId(body.model, 'model');
        const reasoning = optionalReasoning(body.reasoning);
        const deadlineMs = optionalDeadline(body.deadlineMs, 'deadlineMs');
        await authorize({
          action: 'start',
          kind: 'team',
          name,
          sessionId,
          context: handlerContext.context,
        });
        const run = await options.fevex.startTeam(name, {
          input: body.input as JsonValue,
          ...(model ? { model } : {}),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
          ...(sessionId ? { sessionId } : {}),
          ...(handlerContext.context ? { context: handlerContext.context } : {}),
        });
        await commitStart(run);
        return json(run, 202);
      }

      const events = path.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (events && request.method === 'GET') {
        const runId = decodeURIComponent(events[1]!);
        await authorize({ action: 'observe', runId, context: handlerContext.context });
        if (!(await options.fevex.getRun(runId))) throw notFound('RUN_NOT_FOUND', 'Run not found');
        const after = request.headers.get('last-event-id')?.trim() || undefined;
        const initial = await options.fevex.listEvents(runId, { after, limit: eventPageSize });
        if (maxConnections !== undefined && activeConnections >= maxConnections) {
          throw new HttpProtocolError(429, 'CONNECTION_LIMIT', 'Too many event streams');
        }
        activeConnections += 1;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          activeConnections -= 1;
        };
        const disconnected = new AbortController();
        const iterator = observeEvents(
          options.fevex,
          runId,
          initial,
          after,
          pollIntervalMs,
          AbortSignal.any([request.signal, disconnected.signal]),
          eventPageSize,
        );
        return versioned(new Response(iteratorStream(
          iterator,
          () => disconnected.abort(),
          release,
        ), {
          headers: {
            'content-type': `${SSE_TYPE}; charset=utf-8`,
            'cache-control': 'no-cache, no-transform',
          },
        }));
      }

      const resume = path.match(/^\/v1\/runs\/([^/]+)\/resume$/);
      if (resume && request.method === 'POST') {
        const runId = decodeURIComponent(resume[1]!);
        // Authenticate and authorize before revealing whether the run exists.
        const actor = handlerContext.context?.actor;
        if (!actor?.id?.trim()) {
          throw new HttpProtocolError(401, 'ACTOR_REQUIRED', 'Authenticated actor is required');
        }
        await authorize({ action: 'resume', runId, context: handlerContext.context });
        if (!(await options.fevex.getRun(runId))) throw notFound('RUN_NOT_FOUND', 'Run not found');
        const resolution = readResolution(await readJson(request), actor);
        return json(await options.fevex.resumeRun(runId, resolution), 202);
      }

      const recover = path.match(/^\/v1\/runs\/([^/]+)\/recover$/);
      if (recover && request.method === 'POST') {
        const runId = decodeURIComponent(recover[1]!);
        // Authenticate and authorize before revealing whether the run exists.
        const actor = handlerContext.context?.actor;
        if (!actor?.id?.trim()) {
          throw new HttpProtocolError(401, 'ACTOR_REQUIRED', 'Authenticated actor is required');
        }
        await authorize({ action: 'recover', runId, context: handlerContext.context });
        if (!(await options.fevex.getRun(runId))) throw notFound('RUN_NOT_FOUND', 'Run not found');
        return json(await options.fevex.recoverRun(runId, { actor }), 202);
      }

      const runArtifacts = path.match(/^\/v1\/runs\/([^/]+)\/artifacts$/);
      if (runArtifacts && request.method === 'GET') {
        const runId = decodeURIComponent(runArtifacts[1]!);
        await authorizeArtifact({
          action: 'read',
          kind: 'artifacts',
          runId,
          context: handlerContext.context,
        });
        if (!options.artifactCatalog) {
          throw new HttpProtocolError(
            501,
            'ARTIFACT_CATALOG_NOT_CONFIGURED',
            'Artifact catalog is not configured',
          );
        }
        if (!(await options.fevex.getRun(runId))) throw notFound('RUN_NOT_FOUND', 'Run not found');
        const limit = optionalLimit(url.searchParams.get('limit'));
        const records = await options.artifactCatalog.list(
          { runId, ...(limit === undefined ? {} : { limit }) },
          artifactContext(handlerContext, request),
        );
        return json(records.map(({ descriptor }) => descriptor));
      }

      const artifactRoute = path.match(/^\/v1\/artifacts\/([^/]+)$/);
      if (artifactRoute && (request.method === 'GET' || request.method === 'HEAD')) {
        const artifactId = decodeURIComponent(artifactRoute[1]!);
        await authorizeArtifact({
          action: 'read',
          kind: 'artifact',
          artifactId,
          context: handlerContext.context,
        });
        if (!options.artifacts) {
          throw new HttpProtocolError(501, 'ARTIFACTS_NOT_CONFIGURED', 'Artifact store is not configured');
        }
        const context = artifactContext(handlerContext, request);
        if (request.method === 'HEAD' && options.artifacts.head) {
          const descriptor = await options.artifacts.head(artifactId, context);
          if (!descriptor) throw notFound('ARTIFACT_NOT_FOUND', 'Artifact not found');
          return artifactResponse(descriptor, null);
        }
        const content = await options.artifacts.get(artifactId, context);
        if (!content) throw notFound('ARTIFACT_NOT_FOUND', 'Artifact not found');
        return artifactResponse(content.descriptor, request.method === 'HEAD' ? null : content.bytes);
      }
      if (artifactRoute && request.method === 'DELETE') {
        const artifactId = decodeURIComponent(artifactRoute[1]!);
        await authorizeArtifact({
          action: 'delete',
          kind: 'artifact',
          artifactId,
          context: handlerContext.context,
        });
        if (!options.artifacts) {
          throw new HttpProtocolError(501, 'ARTIFACTS_NOT_CONFIGURED', 'Artifact store is not configured');
        }
        if (!options.artifacts.delete) {
          throw new HttpProtocolError(
            501,
            'ARTIFACT_DELETE_UNSUPPORTED',
            'Artifact store does not support deletion',
          );
        }
        const deleted = await options.artifacts.delete(
          artifactId,
          artifactContext(handlerContext, request),
        );
        if (!deleted) throw notFound('ARTIFACT_NOT_FOUND', 'Artifact not found');
        return versioned(new Response(null, { status: 204 }));
      }

      const run = path.match(/^\/v1\/runs\/([^/]+)$/);
      if (run && request.method === 'GET') {
        const runId = decodeURIComponent(run[1]!);
        await authorize({ action: 'read', runId, context: handlerContext.context });
        const value = await options.fevex.getRun(runId);
        if (!value) throw notFound('RUN_NOT_FOUND', 'Run not found');
        return json(value);
      }
      if (run && request.method === 'DELETE') {
        const runId = decodeURIComponent(run[1]!);
        await authorize({ action: 'cancel', runId, context: handlerContext.context });
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

      if (
        start ||
        startWorkflow ||
        startTeam ||
        events ||
        resume ||
        recover ||
        runArtifacts ||
        artifactRoute ||
        run
      ) {
        throw new HttpProtocolError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      }
      throw notFound('ROUTE_NOT_FOUND', 'Route not found');
    } catch (error) {
      return problem(error, url.pathname, options.onError);
    }
  };
}

async function* observeEvents(
  fevex: Fevex,
  runId: string,
  initial: AgentEvent[],
  after: string | undefined,
  pollIntervalMs: number,
  signal: AbortSignal,
  pageSize: number,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  let pending = initial;
  let cursor = after;
  let closedEmptyReads = 0;

  while (!signal.aborted) {
    for (const event of pending) {
      if (signal.aborted) return;
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

    if (pending.length < pageSize) await wait(pollIntervalMs, signal);
    if (signal.aborted) return;
    pending = await fevex.listEvents(runId, { after: cursor, limit: pageSize });
  }
}

function iteratorStream(
  iterator: AsyncGenerator<Uint8Array>,
  cancel: () => void,
  done?: () => void,
) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel() {
      finish();
      cancel();
      await iterator.return(undefined);
    },
  });
}


function formatEvent(event: AgentEvent) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function artifactContext(
  handlerContext: { context?: ExecutionContext },
  request: Request,
): ArtifactStoreContext {
  const tenantId = handlerContext.context?.attributes?.tenantId;
  if (tenantId !== undefined && typeof tenantId !== 'string') {
    throw badRequest('tenantId attribute must be a string');
  }
  const actor = handlerContext.context?.actor;
  return {
    ...(typeof tenantId === 'string' ? { tenantId } : {}),
    ...(actor === undefined ? {} : { actor }),
    signal: request.signal,
  };
}

function optionalLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw badRequest('limit must be a positive integer');
  }
  return parsed;
}

function artifactResponse(
  descriptor: ArtifactDescriptor,
  bytes: Uint8Array | null,
) {
  return versioned(new Response(bytes === null ? null : bytes.slice().buffer, {
    headers: {
      'content-type': descriptor.mimeType,
      'content-length': String(descriptor.size),
      'content-disposition': contentDisposition(descriptor.filename),
      'cache-control': 'private, max-age=0, must-revalidate',
      etag: `"${descriptor.sha256}"`,
      'x-content-type-options': 'nosniff',
      'fevex-artifact-id': descriptor.artifactId,
      'fevex-artifact-sha256': descriptor.sha256,
    },
  }));
}

function contentDisposition(filename: string) {
  const fallback = filename.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_');
  const encoded = encodeURIComponent(filename).replace(/'/gu, '%27');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function readResolution(
  body: Record<string, unknown>,
  actor: NonNullable<ExecutionContext['actor']>,
): ResumeRunResolution {
  if (
    body.type === 'elicitation' &&
    typeof body.requestId === 'string' &&
    body.requestId.trim() &&
    hasOwn(body, 'value')
  ) {
    return {
      type: 'elicitation',
      requestId: body.requestId,
      value: body.value as JsonValue,
      actor,
    };
  }
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
  if (body.type === 'timer') {
    return { type: 'timer', actor };
  }
  if (body.type === 'event' && typeof body.eventName === 'string' && body.eventName.trim()) {
    return {
      type: 'event',
      eventName: body.eventName,
      ...(hasOwn(body, 'payload') ? { payload: body.payload as JsonValue } : {}),
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

function optionalPositiveInteger(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return value as number;
}

function optionalDeadline(value: unknown, name: string) {
  const deadlineMs = optionalPositiveInteger(value, name);
  if (deadlineMs !== undefined && deadlineMs > MAX_DEADLINE_MS) {
    throw badRequest(`${name} must be at most ${MAX_DEADLINE_MS}`);
  }
  return deadlineMs;
}

function optionalReasoning(value: unknown): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    ![
      'provider-default',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ].includes(value)
  ) {
    throw badRequest('reasoning must be a valid effort');
  }
  return value as ReasoningEffort;
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function json(value: unknown, status = 200) {
  return versioned(Response.json(value, { status, headers: { 'content-type': JSON_TYPE } }));
}

function versioned(response: Response) {
  response.headers.set(FEVEX_HTTP_PROTOCOL_VERSION_HEADER, FEVEX_HTTP_PROTOCOL_VERSION);
  return response;
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

function problem(
  error: unknown,
  instance: string,
  onError?: FevexHttpHandlerOptions['onError'],
) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let title = 'Internal Server Error';
  let detail: string | undefined;

  if (error instanceof HttpProtocolError) {
    ({ status, code } = error);
    title = error.message;
    detail = error.message;
  } else if (error instanceof ArtifactError) {
    code = error.code;
    status = statusForArtifactErrorCode(error.code);
    title = titleForStatus(status);
    detail = error.message;
  } else {
    const runError = readFevexRunError(error);
    if (runError) {
      code = runError.code;
      status = statusForRunErrorCode(runError.code);
      title = titleForStatus(status);
      detail = runError.message;
    }
  }

  const value: FevexProblemDetails = {
    type: `urn:fevex:problem:${code.toLowerCase()}`,
    title,
    status,
    code,
    ...(detail ? { detail } : {}),
    instance,
  };
  if (status >= 500) {
    try {
      onError?.(error, value);
    } catch {}
  }
  return versioned(new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': PROBLEM_TYPE },
  }));
}

function readFevexRunError(error: unknown) {
  if (error instanceof FevexRunError) return error;
  if (!error || typeof error !== 'object') return undefined;
  const value = error as Record<string, unknown>;
  return typeof value.message === 'string' &&
    typeof value.code === 'string' &&
    FEVEX_RUN_ERROR_CODES.has(value.code as FevexRunErrorCode)
    ? { code: value.code as FevexRunErrorCode, message: value.message }
    : undefined;
}

function statusForRunErrorCode(code: FevexRunErrorCode) {
  if (
    code === 'AGENT_NOT_FOUND' ||
    code === 'WORKFLOW_NOT_FOUND' ||
    code === 'TEAM_NOT_FOUND' ||
    code === 'SESSION_NOT_FOUND'
  ) return 404;
  if (code === 'APPROVAL_INVALID' || code === 'INVALID_CURSOR') return 400;
  if (code === 'POLICY_DENIED') return 403;
  if (code === 'ADMISSION_DENIED') return 429;
  if (code === 'RUNTIME_CLOSED') return 503;
  return 409;
}

function statusForArtifactErrorCode(code: ArtifactError['code']) {
  if (
    code === 'ARTIFACT_INVALID_ID' ||
    code === 'ARTIFACT_INVALID_INPUT' ||
    code === 'ARTIFACT_INVALID_CONTEXT'
  ) return 400;
  if (code === 'ARTIFACT_TOO_LARGE') return 413;
  if (code === 'ARTIFACT_MIME_UNSUPPORTED') return 415;
  if (code === 'ARTIFACT_CONFLICT') return 409;
  return 500;
}

function titleForStatus(status: number) {
  if (status === 400) return 'Bad Request';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 409) return 'Conflict';
  if (status === 413) return 'Payload Too Large';
  if (status === 415) return 'Unsupported Media Type';
  if (status === 429) return 'Too Many Requests';
  if (status === 501) return 'Not Implemented';
  return 'Internal Server Error';
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
}
