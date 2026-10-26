import { fileURLToPath } from 'node:url';
import { createFixtureService } from './fixtures';

export function startFixtureServer() {
  const fixture = createFixtureService(fileURLToPath(new URL('../../apps/web/src/content/docs/docs/', import.meta.url)));
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, maxRequestBodySize: 64 * 1024,
    fetch: fixture.fetch,
  });
  return { server, calls: fixture.calls };
}
