import { handleAccountsMcpRequest } from './mcp-fixture';

/** Bun HTTP wrapper around the pure MCP fixture. */
export function startMcpFixtureServer() {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 64 * 1024,
    fetch: handleAccountsMcpRequest,
  });
  return {
    server,
    url: new URL('/mcp', server.url),
    close: () => server.stop(true),
  };
}
