import type {
  ObservabilityStats,
  TraceExportQueueOptions,
} from '../observability';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_QUEUED = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FAILURES = 100;
const DEDUPE_WINDOW = 10_000;

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function withDefault(value: number | undefined, fallback: number): number {
  return value ?? fallback;
}

/**
 * Bounded, deduplicated trace export queue. Jobs include building the trace
 * from the store, so a slow store or exporter cannot grow memory without limit.
 */
export function createTraceExportQueue(options: TraceExportQueueOptions = {}) {
  const concurrency = withDefault(options.concurrency, DEFAULT_CONCURRENCY);
  const maxQueued = withDefault(options.maxQueued, DEFAULT_MAX_QUEUED);
  const timeoutMs = withDefault(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxFailures = withDefault(options.maxFailures, DEFAULT_MAX_FAILURES);
  const queue: Array<() => Promise<void>> = [];
  const pending = new Set<Promise<void>>();
  const exportedRuns = new Set<string>();
  const failures: unknown[] = [];
  let active = 0;
  let exported = 0;
  let failed = 0;
  let dropped = 0;
  let unreported = 0;

  const rememberRun = (runId: string): boolean => {
    if (exportedRuns.has(runId)) return false;
    if (exportedRuns.size >= DEDUPE_WINDOW) {
      const oldest = exportedRuns.values().next().value;
      if (oldest !== undefined) exportedRuns.delete(oldest);
    }
    exportedRuns.add(runId);
    return true;
  };

  const recordFailure = (error: unknown): void => {
    failed += 1;
    unreported += 1;
    failures.push(error);
    if (failures.length > maxFailures) failures.shift();
  };

  const startNext = (): void => {
    while (active < concurrency && queue.length) {
      const task = queue.shift()!;
      active += 1;
      let job!: Promise<void>;
      job = Promise.resolve()
        .then(task)
        .then(
          () => {
            exported += 1;
          },
          (error) => {
            recordFailure(error);
          },
        )
        .finally(() => {
          active -= 1;
          pending.delete(job);
          startNext();
        });
      pending.add(job);
    }
  };

  return {
    timeoutMs,
    enqueue(runId: string, task: () => Promise<void>): void {
      if (!rememberRun(runId)) return;
      if (queue.length >= maxQueued) {
        dropped += 1;
        recordFailure(
          new Error(`Observability export queue is full; trace for run "${runId}" was dropped`),
        );
        return;
      }
      queue.push(task);
      startNext();
    },
    async flush(flushOptions?: { timeoutMs?: number }): Promise<void> {
      const timeout = flushOptions?.timeoutMs;
      if (
        timeout !== undefined
        && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout <= 0)
      ) {
        throw new Error('Observability flush timeoutMs must be a positive safe integer');
      }
      const drain = async (): Promise<void> => {
        while (pending.size) await Promise.all([...pending]);
      };
      if (timeout === undefined) {
        await drain();
      } else {
        await withTimeout(
          drain(),
          timeout,
          `Observability flush timed out after ${timeout}ms`,
        );
      }
      if (unreported === 0) return;
      const errors = [...failures];
      const omitted = unreported - failures.length;
      if (omitted > 0) {
        errors.push(new Error(`${omitted} additional export failures were not retained`));
      }
      failures.length = 0;
      unreported = 0;
      throw new AggregateError(
        errors,
        `Observability export failed (${failed} failure(s), ${dropped} dropped trace(s))`,
      );
    },
    stats(): ObservabilityStats {
      return {
        exported,
        failed,
        dropped,
        queued: queue.length,
        active,
        retainedFailures: failures.length,
      };
    },
  };
}
