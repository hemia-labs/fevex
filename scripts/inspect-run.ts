import { parseArgs } from 'node:util';
import type { AgentEvent, RunRecord } from '@fevex/core';
import { createFevexHttpClient, type FevexHttpFetch } from '@fevex/core/http';

const usage = 'bun run inspect RUN_ID [--api http://localhost:3001] [--events] [--after EVENT_ID] [--timeout-ms 10000]';

/** Metadata only: never forward raw run output, pause inputs or event payloads. */
export function summarizeRun(run: RunRecord) {
  return {
    runId: run.id,
    sessionId: run.sessionId,
    kind: run.kind ?? 'agent',
    name: run.kind === 'workflow' ? run.workflowName : run.kind === 'team' ? run.teamName : run.agentName,
    status: run.status,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    pauseType: run.pause?.type,
    usage: run.usage && {
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      totalTokens: run.usage.totalTokens,
    },
  };
}

export function summarizeEvent(event: AgentEvent) {
  const payload = event.payload;
  const metadata = {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    timestamp: event.timestamp,
    runId: event.runId,
  };
  if (!payload) return metadata;
  return {
    ...metadata,
    ...('step' in payload ? { step: payload.step } : {}),
    ...('toolName' in payload ? { toolName: payload.toolName } : {}),
    ...('errorCode' in payload ? { errorCode: payload.errorCode } : {}),
    ...('source' in payload && payload.source ? { source: {
      provider: payload.source.provider,
      connectionName: payload.source.connectionName,
      remoteToolName: payload.source.remoteToolName,
    } } : {}),
  };
}

export async function inspectRun(
  args = process.argv.slice(2),
  fetchImpl: FevexHttpFetch = fetch,
  write: (line: string) => void = console.log,
) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    api: { type: 'string', default: 'http://localhost:3001' },
    events: { type: 'boolean', default: false },
    after: { type: 'string' },
    'timeout-ms': { type: 'string', default: '10000' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { write(usage); return; }
  if (positionals.length !== 1 || !positionals[0]?.trim()) throw new TypeError(usage);
  if (values.after !== undefined && (!values.events || !values.after.trim())) {
    throw new TypeError('--after requires --events and a non-empty event ID');
  }
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('--timeout-ms must be a positive integer up to 2147483647');
  }
  const api = new URL(values.api);
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash) {
    throw new TypeError('--api must be an HTTP(S) URL without credentials, query or fragment');
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const client = createFevexHttpClient({ baseUrl: api.href, fetch: (input, init) => {
    const headers = new Headers(init?.headers);
    if (process.env.FEVEX_API_TOKEN) headers.set('authorization', `Bearer ${process.env.FEVEX_API_TOKEN}`);
    return fetchImpl(input, { ...init, headers, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
  } });
  const runId = positionals[0];
  write(JSON.stringify({ run: summarizeRun(await client.getRun(runId)) }));
  if (values.events) {
    for await (const event of client.observeRun(runId, { signal, after: values.after })) {
      write(JSON.stringify({ event: summarizeEvent(event) }));
    }
    write(JSON.stringify({ run: summarizeRun(await client.getRun(runId)) }));
  }
}

if (import.meta.main) {
  try {
    await inspectRun();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Run inspection failed');
    process.exitCode = 1;
  }
}
