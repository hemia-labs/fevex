import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSoak } from './soak';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('runSoak', () => {
  test('completes a bounded memory workload and flushes traces', async () => {
    const report = await runSoak({
      durationMs: 400,
      concurrency: 2,
      sampleIntervalMs: 50,
      purgeIntervalMs: 100,
      retentionMs: 0,
      verifyEvery: 1,
      shutdownTimeoutMs: 1_000,
      maxRssGrowthMb: 1_024,
      maxHeapGrowthMb: 1_024,
      overheadBudgetMs: 1_000,
    });

    expect(report.pass).toBe(true);
    expect(report.runs.completed).toBeGreaterThan(0);
    expect(report.runs.failed).toBe(0);
    expect(report.runs.historyChecks).toBeGreaterThan(0);
    expect(report.runs.historyFailures).toBe(0);
    expect(report.shutdown.timedOut).toBe(false);
    expect(report.observability.exported).toBe(report.runs.completed);
  });

  test('runs the same workload against SQLite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fevex-soak-'));
    temporaryDirectories.push(directory);
    const report = await runSoak({
      durationMs: 400,
      concurrency: 2,
      sampleIntervalMs: 50,
      purgeIntervalMs: 100,
      retentionMs: 0,
      verifyEvery: 1,
      store: 'sqlite',
      database: join(directory, 'soak.sqlite'),
      shutdownTimeoutMs: 1_000,
      maxRssGrowthMb: 1_024,
      maxHeapGrowthMb: 1_024,
      overheadBudgetMs: 1_000,
    });

    expect(report.pass).toBe(true);
    expect(report.runs.completed).toBeGreaterThan(0);
    expect(report.runs.historyFailures).toBe(0);
    expect(report.retention.sweeps).toBeGreaterThan(0);
  });
});
