import 'reflect-metadata';
import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpToolProvider } from '@fevex/mcp';
import { McpController } from './mcp.controller';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

test('MCP provider interoperates with the Nest 2026-07-28 server over HTTP', async () => {
  const controller = new McpController();
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    (request as typeof request & { body?: unknown }).body = body ? JSON.parse(body) : undefined;
    controller.handleMcp(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const provider = createMcpToolProvider({
    url: `http://127.0.0.1:${port}/mcp`,
    requestTimeoutMs: 2_000,
  });

  const tools = await provider.listTools();
  expect(tools.map(({ name }) => name)).toEqual([
    'echo',
    'sum',
    'multiply',
    'slugify',
    'word_count',
  ]);
  await expect(provider.callTool('sum', { a: 2, b: 3 }, {})).resolves.toEqual({ result: 5 });
  await expect(provider.callTool('slugify', { text: 'Hola Fevex' }, {}))
    .resolves.toEqual({ slug: 'hola-fevex' });
});
