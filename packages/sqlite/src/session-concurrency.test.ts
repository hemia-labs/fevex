import { test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSQLiteRunStore } from './index';
import { testSessionProcesses } from '../../../tests/session-process';
import { testLeaseProcesses } from '../../../tests/lease-process';

for (const [name, check] of [
  ['protects session history across processes and crashes', testSessionProcesses],
  ['fences stale lease generations across processes', testLeaseProcesses],
] as const) test(name, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fevex-session-'));
  const filename = join(directory, 'runs.sqlite');
  const store = createSQLiteRunStore({ filename });
  try {
    await check('sqlite', filename, store);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
