import { test } from 'bun:test';
import { createPostgresRunStore } from './index';
import { testSessionProcesses } from '../../../tests/session-process';
import { testLeaseProcesses } from '../../../tests/lease-process';

const connectionString = process.env.FEVEX_POSTGRES_URL;
if (process.env.FEVEX_REQUIRE_POSTGRES === '1' && !connectionString?.trim()) {
  throw new Error('FEVEX_POSTGRES_URL is required for PostgreSQL integration tests');
}
for (const [name, check] of [
  ['protects PostgreSQL session history across processes and crashes', testSessionProcesses],
  ['fences stale PostgreSQL lease generations across processes', testLeaseProcesses],
] as const) test.skipIf(!connectionString)(name, async () => {
  const store = createPostgresRunStore({ connectionString: connectionString! });
  try {
    await store.migrate();
    await check('postgres', connectionString!, store);
  } finally {
    await store.close();
  }
}, 15_000);
