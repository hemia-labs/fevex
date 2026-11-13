import type { AgentEvent } from '../core';
import type { ArtifactDescriptor } from '../artifacts';
import {
  FEVEX_HTTP_PROTOCOL_VERSION,
  FEVEX_HTTP_PROTOCOL_VERSION_HEADER,
  type FevexHttpClient,
  type FevexHttpClientOptions,
  type FevexHttpFetch,
  type FevexProblemDetails,
} from './protocol';

const JSON_TYPE = 'application/json';
const PROBLEM_TYPE = 'application/problem+json';
const SSE_TYPE = 'text/event-stream';

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
    startTeam(teamName, body) {
      return request(
        `/v1/teams/${encodeURIComponent(teamName)}/runs`,
        jsonInit('POST', body),
      );
    },
    getRun(runId) {
      return request(`/v1/runs/${encodeURIComponent(runId)}`);
    },
    listRuns(listOptions = {}) {
      const params = new URLSearchParams();
      if (listOptions.limit !== undefined) params.set('limit', String(listOptions.limit));
      if (listOptions.status !== undefined) params.set('status', listOptions.status);
      if (listOptions.cursor !== undefined) params.set('cursor', listOptions.cursor);
      const query = params.toString();
      return request(`/v1/runs${query ? `?${query}` : ''}`);
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
    recoverRun(runId) {
      return request(`/v1/runs/${encodeURIComponent(runId)}/recover`, { method: 'POST' });
    },
    async cancelRun(runId) {
      const response = await fetcher(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
        method: 'DELETE',
      });
      await assertResponse(response);
    },
    async getArtifact(artifactId) {
      const response = await fetcher(`${baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}`);
      await assertResponse(response);
      return response;
    },
    listArtifacts(runId) {
      return request<ArtifactDescriptor[]>(`/v1/runs/${encodeURIComponent(runId)}/artifacts`);
    },
    async deleteArtifact(artifactId) {
      const response = await fetcher(`${baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}`, {
        method: 'DELETE',
      });
      await assertResponse(response);
    },
  };
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

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': JSON_TYPE },
    body: JSON.stringify(body),
  };
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
