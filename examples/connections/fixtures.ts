import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileFevexJsonSchema, type JsonObject, type JsonValue } from '@fevex/core';
import { FEVEX_MCP_PROTOCOL_VERSION } from '@fevex/mcp';

const searchSchema: JsonObject = {
  type: 'object',
  properties: { query: { type: 'string', minLength: 1, maxLength: 100 } },
  required: ['query'],
  additionalProperties: false,
};
const validateSearch = compileFevexJsonSchema(searchSchema);

export const accountsApi: JsonObject = {
  openapi: '3.1.0',
  info: { title: 'Example Accounts API', version: '1.0.0' },
  paths: {
    '/accounts/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      get: {
        operationId: 'getAccount',
        summary: 'Read account status and plan',
        responses: {
          '200': {
            description: 'Account found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Account' } } },
          },
        },
      },
      delete: {
        operationId: 'deleteAccount',
        responses: { '204': { description: 'Account deleted' } },
      },
    },
  },
  components: {
    schemas: {
      Account: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          status: { enum: ['active', 'paused'] },
          plan: { enum: ['free', 'pro'] },
        },
        required: ['id', 'status', 'plan'],
        additionalProperties: false,
      },
    },
  },
};

/** A small test fixture, not a production MCP server or account service. */
export function createFixtureService(documentsPath: string) {
  const documents = [
    { slug: 'agents', title: 'Agents' },
    { slug: 'tools', title: 'Tools' },
    { slug: 'workflows', title: 'Workflows & teams' },
  ].map(({ slug, title }) => ({
    title,
    url: `https://fevex.dev/docs/${slug}/`,
    text: readFileSync(join(documentsPath, `${slug}.md`), 'utf8'),
  }));
  const calls = { search: 0, getAccount: 0 };
  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === '/accounts/42' && request.method === 'GET') {
      calls.getAccount += 1;
      return Response.json({ id: 42, status: 'active', plan: 'pro' });
    }
    if (path === '/accounts/503' && request.method === 'GET') {
      calls.getAccount += 1;
      return Response.json({ error: 'Example service unavailable' }, { status: 503 });
    }
    if (path !== '/mcp') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });

    let message: {
      jsonrpc: string;
      id?: number | string;
      method: string;
      params?: { name?: string; arguments?: JsonValue };
    };
    try {
      message = await request.json();
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        throw new Error('Invalid request');
      }
    } catch {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, { status: 400 });
    }
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: message.id, result });
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: FEVEX_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'fevex-docs-fixture', version: '1.0.0' },
        });
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list':
        return reply({ tools: [
          { name: 'search', description: 'Search Fevex documentation and return sources.', inputSchema: searchSchema },
          { name: 'deleteDocs', description: 'Example write tool excluded by the host.', inputSchema: { type: 'object' } },
        ] });
      case 'tools/call': {
        if (message.params?.name !== 'search') break;
        let query: string;
        try {
          query = (validateSearch.validate(message.params.arguments) as { query: string }).query;
        } catch {
          return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Invalid search arguments' } });
        }
        calls.search += 1;
        const matches = documents.flatMap(({ title, url, text }) => documentSections(text)
          .filter((section) => section.toLowerCase().includes(query.toLowerCase()) && section.length <= 6000)
          .map((excerpt) => ({ title, url, excerpt }))).slice(0, 3);
        return reply({
          content: [{ type: 'text', text: JSON.stringify({ matches }) }],
          structuredContent: { matches },
        });
      }
    }
    return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method or tool not supported by this fixture' } });
  };
  return { fetch, calls };
}

/** ponytail: bounded heading sections for three local docs; use an indexed retriever for a larger corpus. */
export function documentSections(markdown: string): string[] {
  const sections: string[] = [];
  let lines: string[] = [];
  let fence = '';
  for (const line of markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && /^#{1,6}\s/.test(line) && lines.length) {
      sections.push(lines.join('\n').trim()); lines = [];
    }
    lines.push(line);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length
        && line.slice(marker[0].length).trim() === '') fence = '';
    }
  }
  // Do not return an incomplete code example.
  if (!fence && lines.length) sections.push(lines.join('\n').trim());
  return sections.filter(Boolean);
}

/** Complete fenced code bodies, preserving internal whitespace. */
export function codeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let fence = '';
  let lines: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && marker) { fence = marker[1]!; lines = []; }
    else if (fence && marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length
      && line.slice(marker[0].length).trim() === '') {
      blocks.push(lines.join('\n')); fence = ''; lines = [];
    } else if (fence) lines.push(line);
  }
  if (fence) throw new Error('Unclosed documentation code block');
  return blocks;
}
