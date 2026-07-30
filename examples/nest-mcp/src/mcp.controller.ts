import type { IncomingMessage, ServerResponse } from 'node:http';
import { All, Controller, Get, Req, Res } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';

type NestRequest = IncomingMessage & { body?: unknown };

@Controller()
export class McpController {
  @Get()
  status() {
    return { name: 'nest-mcp', status: 'ok', endpoint: '/mcp' };
  }

  @All('mcp')
  async handleMcp(@Req() request: NestRequest, @Res() response: ServerResponse) {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    response.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  }
}

function createServer() {
  const server = new McpServer({ name: 'fevex-test-mcp', version: '1.0.0' });

  server.registerTool('echo', {
    description: 'Return the received message.',
    inputSchema: { message: z.string() },
    outputSchema: { message: z.string() },
  }, async ({ message }) => ({
    content: [{ type: 'text', text: message }],
    structuredContent: { message },
  }));

  server.registerTool('sum', {
    description: 'Add two numbers.',
    inputSchema: { a: z.number(), b: z.number() },
    outputSchema: { result: z.number() },
  }, async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
    structuredContent: { result: a + b },
  }));

  server.registerTool('multiply', {
    description: 'Multiply two numbers.',
    inputSchema: { a: z.number(), b: z.number() },
    outputSchema: { result: z.number() },
  }, async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a * b) }],
    structuredContent: { result: a * b },
  }));

  server.registerTool('slugify', {
    description: 'Convert text into a URL-friendly slug.',
    inputSchema: { text: z.string() },
    outputSchema: { slug: z.string() },
  }, async ({ text }) => {
    const slug = text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return {
      content: [{ type: 'text', text: slug }],
      structuredContent: { slug },
    };
  });

  server.registerTool('word_count', {
    description: 'Count words in a text.',
    inputSchema: { text: z.string() },
    outputSchema: { count: z.number() },
  }, async ({ text }) => {
    const count = text.trim() ? text.trim().split(/\s+/).length : 0;
    return {
      content: [{ type: 'text', text: String(count) }],
      structuredContent: { count },
    };
  });

  return server;
}
