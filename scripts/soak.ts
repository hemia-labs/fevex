import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import {
  createFevex,
  defineAgent,
  defineTool,
  InMemoryRunStore,
  type Fevex,
  type ModelGateway,
  type RunStore,
} from '@fevex/core';

const usage = `bun run soak -- [options]

Options:
  --duration-ms <ms>          Load window. Default: 60000
  --run-deadline-ms <ms>      Per-run deadline. Default: 30000
  --concurrency <n>           Concurrent runs. Default: 8
  --model-delay-ms <ms>       Simulated latency per model call. Default: 0
  --tool-delay-ms <ms>        Simulated latency per tool call. Default: 0
  --sample-interval-ms <ms>   Memory sample interval. Default: 5000
  --purge-interval-ms <ms>    Retention sweep interval. Default: 10000
  --retention-ms <ms>         Retain terminal runs at least this long. Default: 10000
  --verify-every <n>          Verify history every n runs; 0 disables. Default: 100
  --store <memory|sqlite|postgres>
  --database <path|url>       SQLite path or PostgreSQL connection string
  --shutdown-timeout-ms <ms>  Graceful shutdown budget. Default: 30000
  --max-rss-growth-mb <mb>    Allowed RSS growth after warm-up. Default: 512
  --max-heap-growth-mb <mb>   Allowed heap growth after warm-up. Default: 64
  --overhead-budget-ms <ms>   p95 runtime overhead budget
  --max-errors <n>            Abort after this many failed runs. Default: 0
  --report <path>             Write the JSON report to a file
  --help                      Show this help`;

export type SoakStore = 'memory' | 'sqlite' | 'postgres';

export interface SoakOptions {
  durationMs?: number;
  runDeadlineMs?: number;
  concurrency?: number;
  modelDelayMs?: number;
  toolDelayMs?: number;
  sampleIntervalMs?: number;
  purgeIntervalMs?: number;
  retentionMs?: number;
  verifyEvery?: number;
  store?: SoakStore;
  database?: string;
  shutdownTimeoutMs?: number;
  maxRssGrowthMb?: number;
  maxHeapGrowthMb?: number;
  overheadBudgetMs?: number;
  maxErrors?: number;
  reportPath?: string;
}

export interface SoakReport {
  schemaVersion: '1';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  config: {
    concurrency: number;
    runDeadlineMs: number;
    modelDelayMs: number;
    toolDelayMs: number;
    store: SoakStore;
    shutdownTimeoutMs: number;
  };
  runs: {
    started: number;
    completed: number;
    failed: number;
    perSecond: number;
    historyChecks: number;
    historyFailures: number;
  };
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  overheadMs: { p50: number; p95: number; p99: number; max: number };
  eventLoopDelayMs: { p50: number; p95: number; p99: number; max: number };
  memory: {
    rssStartMb: number;
    rssEndMb: number;
    rssPeakMb: number;
    rssGrowthMb: number;
    baselineRssMb: number;
    tailRssMb: number;
    heapStartMb: number;
    heapEndMb: number;
    heapPeakMb: number;
    heapGrowthMb: number;
    baselineHeapMb: number;
    tailHeapMb: number;
    samples: number;
  };
  retention: { runs: number; sessions: number; sweeps: number };
  observability: {
    exported: number;
    failed: number;
    dropped: number;
    retainedFailures: number;
  };
  shutdown: {
    timedOut: boolean;
    cancelledRunIds: string[];
    exportError?: string;
  };
  pass: boolean;
  gates: {
    runsCompleted: boolean;
    noRunFailures: boolean;
    historyIntact: boolean;
    overheadWithinBudget: boolean;
    memoryStable: boolean;
    shutdownCompleted: boolean;
  };
  errors?: string[];
}

const MB = 1024 * 1024;

class SampleSet {
  readonly #values: number[] = [];
  readonly #limit: number;
  #seen = 0;

  constructor(limit = 50_000) {
    this.#limit = limit;
  }

  add(value: number): void {
    this.#seen += 1;
    if (this.#values.length < this.#limit) {
      this.#values.push(value);
      return;
    }
    const index = Math.floor(Math.random() * this.#seen);
    if (index < this.#limit) this.#values[index] = value;
  }

  get size(): number {
    return this.#values.length;
  }

  percentile(percentile: number): number {
    if (this.#values.length === 0) return 0;
    const sorted = [...this.#values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1);
    return sorted[Math.max(0, index)]!;
  }

  max(): number {
    return this.#values.length === 0 ? 0 : Math.max(...this.#values);
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return resolved;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function collectGarbage(): void {
  const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun;
  if (bun?.gc) {
    bun.gc(true);
    return;
  }
  (globalThis as { gc?: () => void }).gc?.();
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
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

function soakModel(modelDelayMs: number): ModelGateway {
  return {
    metadata: { provider: 'soak', model: 'deterministic' },
    async *stream(input) {
      await abortableDelay(modelDelayMs, input.signal);
      const hasToolResult = input.messages.some(({ role }) => role === 'tool');
      if (!hasToolResult) {
        yield {
          type: 'completed',
          result: {
            toolCalls: [{ id: crypto.randomUUID(), name: 'soak__noop', input: {} }],
          },
        };
        return;
      }
      yield { type: 'output.delta', delta: 'ok' };
      yield { type: 'completed', result: { output: 'ok' } };
    },
  };
}

async function openStore(options: SoakOptions): Promise<{
  store: RunStore;
  close: () => Promise<void>;
}> {
  const store = options.store ?? 'memory';
  if (store === 'memory') {
    return { store: new InMemoryRunStore(), close: async () => {} };
  }
  if (store === 'sqlite') {
    const { createSQLiteRunStore } = await import('@fevex/sqlite');
    const database = options.database ?? '.fevex/soak.sqlite';
    const runStore = createSQLiteRunStore({ filename: database });
    return { store: runStore, close: () => runStore.close() };
  }
  const { createPostgresRunStore } = await import('@fevex/postgres');
  const connectionString = options.database ?? process.env.FEVEX_POSTGRES_URL;
  if (!connectionString) {
    throw new TypeError('--database or FEVEX_POSTGRES_URL is required for --store=postgres');
  }
  const runStore = createPostgresRunStore({ connectionString });
  await runStore.migrate();
  return { store: runStore, close: () => runStore.close() };
}

export async function runSoak(options: SoakOptions = {}): Promise<SoakReport> {
  const durationMs = positiveInteger(options.durationMs, 60_000, 'durationMs');
  const runDeadlineMs = positiveInteger(options.runDeadlineMs, 30_000, 'runDeadlineMs');
  const concurrency = positiveInteger(options.concurrency, 8, 'concurrency');
  const modelDelayMs = nonNegativeInteger(options.modelDelayMs, 0, 'modelDelayMs');
  const toolDelayMs = nonNegativeInteger(options.toolDelayMs, 0, 'toolDelayMs');
  const sampleIntervalMs = positiveInteger(options.sampleIntervalMs, 5_000, 'sampleIntervalMs');
  const purgeIntervalMs = positiveInteger(options.purgeIntervalMs, 10_000, 'purgeIntervalMs');
  const retentionMs = nonNegativeInteger(options.retentionMs, 10_000, 'retentionMs');
  const verifyEvery = nonNegativeInteger(options.verifyEvery, 100, 'verifyEvery');
  const shutdownTimeoutMs = nonNegativeInteger(
    options.shutdownTimeoutMs,
    30_000,
    'shutdownTimeoutMs',
  );
  const maxRssGrowthMb = nonNegativeInteger(options.maxRssGrowthMb, 512, 'maxRssGrowthMb');
  const maxHeapGrowthMb = nonNegativeInteger(options.maxHeapGrowthMb, 64, 'maxHeapGrowthMb');
  const maxErrors = nonNegativeInteger(options.maxErrors, 0, 'maxErrors');
  const store = options.store ?? 'memory';
  if (!['memory', 'sqlite', 'postgres'].includes(store)) {
    throw new TypeError('store must be memory, sqlite or postgres');
  }
  const overheadBudgetMs = options.overheadBudgetMs ?? (store === 'memory' ? 10 : 50);
  if (!Number.isFinite(overheadBudgetMs) || overheadBudgetMs <= 0) {
    throw new TypeError('overheadBudgetMs must be a positive number');
  }

  const startedAt = new Date();
  const { store: runStore, close } = await openStore({ ...options, store });
  const latency = new SampleSet();
  const overhead = new SampleSet();
  const memorySamples: Array<{ at: number; rss: number; heap: number }> = [];
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  let launched = 0;
  let completed = 0;
  let failed = 0;
  let historyChecks = 0;
  let historyFailures = 0;
  let purgedRuns = 0;
  let purgedSessions = 0;
  let purgeSweeps = 0;
  let purging = false;
  let stop = false;
  let lastPurge = Promise.resolve();
  const errorMessages: string[] = [];
  let app!: Fevex;

  const verifyHistory = async (runId: string): Promise<void> => {
    historyChecks += 1;
    const run = await app.getRun(runId);
    if (!run || run.status !== 'completed') {
      historyFailures += 1;
      return;
    }
    const events = await app.listEvents(runId, { limit: 1_000 });
    if (events.at(-1)?.type !== 'run.completed') {
      historyFailures += 1;
      return;
    }
    for (let index = 1; index < events.length; index += 1) {
      if (events[index]!.sequence !== events[index - 1]!.sequence + 1) {
        historyFailures += 1;
        return;
      }
    }
  };

  const purge = async (): Promise<void> => {
    if (purging || stop) return;
    purging = true;
    try {
      let purged = 0;
      do {
        const result = await app.purgeRuns({
          statuses: ['completed', 'failed', 'cancelled'],
          before: new Date(Date.now() - retentionMs).toISOString(),
          limit: 5_000,
        });
        purgedRuns += result.runs;
        purgedSessions += result.sessions;
        purged = result.runs;
        if (result.runs === 5_000 && !stop) await yieldEventLoop();
      } while (purged === 5_000 && !stop);
      purgeSweeps += 1;
    } catch (error) {
      errorMessages.push(`retention: ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
    } finally {
      purging = false;
    }
  };

  app = createFevex({
    models: { default: soakModel(modelDelayMs) },
    agents: [defineAgent({
      name: 'soak',
      instructions: 'Execute the deterministic soak workload.',
      tools: ['soak__noop'],
    })],
    tools: [defineTool({
      name: 'soak__noop',
      idempotency: 'none',
      async execute() {
        await abortableDelay(toolDelayMs);
        return { ok: true };
      },
    })],
    runStore,
    admission: { maxActiveRuns: concurrency },
    limits: { maxEventsPerRun: 1_000 },
    observability: {
      exporters: [{ export() {} }],
      exportQueue: { concurrency: 4, maxQueued: 100, timeoutMs: 30_000 },
    },
  });

  eventLoop.enable();
  const sampleMemory = (at: number): void => {
    collectGarbage();
    const usage = process.memoryUsage();
    memorySamples.push({ at, rss: usage.rss, heap: usage.heapUsed });
  };
  const sampleTimer = setInterval(() => sampleMemory(performance.now()), sampleIntervalMs);
  sampleTimer.unref?.();
  sampleMemory(0);
  const purgeTimer = setInterval(() => {
    lastPurge = purge();
  }, purgeIntervalMs);
  purgeTimer.unref?.();

  const loadStarted = performance.now();
  const deadline = loadStarted + durationMs;
  let loadDurationMs = durationMs;
  try {
    const workers = Array.from({ length: concurrency }, async () => {
      while (!stop && performance.now() < deadline) {
        const runNumber = ++launched;
        const runStarted = performance.now();
        try {
          const result = await app.runAgent('soak', {
            input: `run-${runNumber}`,
            deadlineMs: runDeadlineMs,
          });
          const elapsed = performance.now() - runStarted;
          completed += 1;
          latency.add(elapsed);
          overhead.add(Math.max(0, elapsed - (modelDelayMs * 2 + toolDelayMs)));
          if (verifyEvery > 0 && runNumber % verifyEvery === 0) {
            try {
              await verifyHistory(result.runId);
            } catch (error) {
              historyFailures += 1;
              errorMessages.push(
                `history: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        } catch (error) {
          failed += 1;
          errorMessages.push(error instanceof Error ? error.message : String(error));
          if (failed > maxErrors) {
            stop = true;
            break;
          }
        }
        await yieldEventLoop();
      }
    });
    await Promise.all(workers);
    loadDurationMs = performance.now() - loadStarted;
  } finally {
    clearInterval(sampleTimer);
    clearInterval(purgeTimer);
    await lastPurge;
    eventLoop.disable();
  }

  const shutdown = await app.shutdown({ timeoutMs: shutdownTimeoutMs });
  const endedAt = new Date();
  await close();

  const warmupMs = Math.max(
    retentionMs * 2,
    sampleIntervalMs * 2,
    Math.min(60_000, durationMs * 0.1),
  );
  const afterWarmup = memorySamples.filter(({ at }) => at >= warmupMs);
  const stableSamples = afterWarmup.length ? afterWarmup : memorySamples;
  const windowSize = Math.max(1, Math.ceil(stableSamples.length * 0.2));
  const baselineSamples = stableSamples.slice(0, windowSize);
  const tailSamples = stableSamples.slice(-windowSize);
  const baselineRss = median(baselineSamples.map(({ rss }) => rss));
  const tailRss = median(tailSamples.map(({ rss }) => rss));
  const baselineHeap = median(baselineSamples.map(({ heap }) => heap));
  const tailHeap = median(tailSamples.map(({ heap }) => heap));
  const rssStart = memorySamples[0]?.rss ?? 0;
  const rssEnd = memorySamples.at(-1)?.rss ?? 0;
  const rssPeak = memorySamples.reduce((peak, { rss }) => Math.max(peak, rss), 0);
  const heapStart = memorySamples[0]?.heap ?? 0;
  const heapEnd = memorySamples.at(-1)?.heap ?? 0;
  const heapPeak = memorySamples.reduce((peak, { heap }) => Math.max(peak, heap), 0);
  const rssGrowth = tailRss - baselineRss;
  const heapGrowth = tailHeap - baselineHeap;
  const latencyP95 = latency.percentile(0.95);
  const overheadP95 = overhead.percentile(0.95);
  const gates = {
    runsCompleted: completed > 0,
    noRunFailures: failed === 0,
    historyIntact: historyFailures === 0,
    overheadWithinBudget: overheadP95 <= overheadBudgetMs,
    memoryStable:
      heapGrowth <= maxHeapGrowthMb * MB && rssGrowth <= maxRssGrowthMb * MB,
    shutdownCompleted: !shutdown.timedOut && shutdown.exportError === undefined,
  };
  const report: SoakReport = {
    schemaVersion: '1',
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.round(loadDurationMs),
    config: {
      concurrency,
      runDeadlineMs,
      modelDelayMs,
      toolDelayMs,
      store,
      shutdownTimeoutMs,
    },
    runs: {
      started: launched,
      completed,
      failed,
      perSecond: round(completed / (Math.max(1, loadDurationMs) / 1_000)),
      historyChecks,
      historyFailures,
    },
    latencyMs: {
      p50: round(latency.percentile(0.5)),
      p95: round(latencyP95),
      p99: round(latency.percentile(0.99)),
      max: round(latency.max()),
    },
    overheadMs: {
      p50: round(overhead.percentile(0.5)),
      p95: round(overheadP95),
      p99: round(overhead.percentile(0.99)),
      max: round(overhead.max()),
    },
    eventLoopDelayMs: {
      p50: round(eventLoop.percentile(50) / 1e6),
      p95: round(eventLoop.percentile(95) / 1e6),
      p99: round(eventLoop.percentile(99) / 1e6),
      max: round(eventLoop.max / 1e6),
    },
    memory: {
      rssStartMb: round(rssStart / MB),
      rssEndMb: round(rssEnd / MB),
      rssPeakMb: round(rssPeak / MB),
      rssGrowthMb: round(rssGrowth / MB),
      baselineRssMb: round(baselineRss / MB),
      tailRssMb: round(tailRss / MB),
      heapStartMb: round(heapStart / MB),
      heapEndMb: round(heapEnd / MB),
      heapPeakMb: round(heapPeak / MB),
      heapGrowthMb: round(heapGrowth / MB),
      baselineHeapMb: round(baselineHeap / MB),
      tailHeapMb: round(tailHeap / MB),
      samples: memorySamples.length,
    },
    retention: {
      runs: purgedRuns,
      sessions: purgedSessions,
      sweeps: purgeSweeps,
    },
    observability: {
      exported: shutdown.observability.exported,
      failed: shutdown.observability.failed,
      dropped: shutdown.observability.dropped,
      retainedFailures: shutdown.observability.retainedFailures,
    },
    shutdown: {
      timedOut: shutdown.timedOut,
      cancelledRunIds: shutdown.cancelledRunIds,
      ...(shutdown.exportError === undefined
        ? {}
        : { exportError: String(shutdown.exportError) }),
    },
    pass: Object.values(gates).every(Boolean),
    gates,
  };
  if (errorMessages.length) report.errors = errorMessages.slice(0, 10);
  if (options.reportPath) {
    mkdirSync(dirname(resolve(options.reportPath)), { recursive: true });
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'duration-ms': { type: 'string' },
      'run-deadline-ms': { type: 'string' },
      concurrency: { type: 'string' },
      'model-delay-ms': { type: 'string' },
      'tool-delay-ms': { type: 'string' },
      'sample-interval-ms': { type: 'string' },
      'purge-interval-ms': { type: 'string' },
      'retention-ms': { type: 'string' },
      'verify-every': { type: 'string' },
      store: { type: 'string' },
      database: { type: 'string' },
      'shutdown-timeout-ms': { type: 'string' },
      'max-rss-growth-mb': { type: 'string' },
      'max-heap-growth-mb': { type: 'string' },
      'overhead-budget-ms': { type: 'string' },
      'max-errors': { type: 'string' },
      report: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const number = (value: string | undefined): number | undefined =>
    value === undefined ? undefined : Number(value);
  const report = await runSoak({
    durationMs: number(values['duration-ms']),
    runDeadlineMs: number(values['run-deadline-ms']),
    concurrency: number(values.concurrency),
    modelDelayMs: number(values['model-delay-ms']),
    toolDelayMs: number(values['tool-delay-ms']),
    sampleIntervalMs: number(values['sample-interval-ms']),
    purgeIntervalMs: number(values['purge-interval-ms']),
    retentionMs: number(values['retention-ms']),
    verifyEvery: number(values['verify-every']),
    store: values.store as SoakStore | undefined,
    database: values.database,
    shutdownTimeoutMs: number(values['shutdown-timeout-ms']),
    maxRssGrowthMb: number(values['max-rss-growth-mb']),
    maxHeapGrowthMb: number(values['max-heap-growth-mb']),
    overheadBudgetMs: number(values['overhead-budget-ms']),
    maxErrors: number(values['max-errors']),
    reportPath: values.report,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
