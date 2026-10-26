import assert from 'node:assert/strict';
import { createFevex, defineAgent, defineConnection } from '@fevex/core';
import { fakeModel } from '@fevex/core/testing';
import { createMcpToolProvider } from '@fevex/mcp';
import { createOpenApiToolProvider } from '@fevex/openapi';
import { accountsApi } from './fixtures';
import { startFixtureServer } from './server';

export async function runDemo() {
  const { server, calls } = startFixtureServer();
  try {
    // MCP discovers a remote catalog; the host only exposes its read tool.
    const docs = defineConnection({
      name: 'docs',
      provider: createMcpToolProvider({ url: new URL('/mcp', server.url), requestTimeoutMs: 5_000 }),
      allowlist: ['search'],
      tools: { search: { risk: 'read', approval: 'never' } },
    });
    const docsModel = fakeModel(
      { toolCalls: [{ id: 'search-docs', name: 'docs__search', input: { query: 'resumeRun' } }] },
      { output: 'Resume paused runs with resumeRun. An external worker can recover orphaned runs. Source: https://fevex.dev/docs/workflows/' },
    );
    const researcher = createFevex({
      models: { demo: docsModel },
      agents: [defineAgent({
        name: 'researcher', model: 'demo',
        instructions: 'Search the documentation before answering. Include source URLs from the tool results.',
        tools: ['docs__search'],
      })],
      connections: [docs],
    });
    const research = await researcher.runAgent('researcher', { input: 'How do I resume a paused Fevex run?' });
    const docsReply = docsModel.calls[1]?.messages.find((message) => message.role === 'tool');
    assert(docsReply?.content, 'The model must receive the MCP result');
    const search = JSON.parse(docsReply.content) as { matches: { title: string; url: string; excerpt: string }[] };
    assert(search.matches.some((match) => match.excerpt.includes('resumeRun')));
    assert.deepEqual(docsModel.calls[0]?.tools?.map((tool) => tool.name), ['docs__search']);
    assert(research.events?.some((event) => event.type === 'tool.completed'
      && event.payload.source?.provider === 'mcp'
      && event.payload.source.connectionName === 'docs'));

    // OpenAPI generates input and output validation from a bundled 3.1 document.
    const accounts = defineConnection({
      name: 'accounts',
      provider: createOpenApiToolProvider({
        document: accountsApi,
        baseUrl: server.url,
        operations: { allow: ['getAccount'] },
        requestTimeoutMs: 5_000,
      }),
      allowlist: ['getAccount'],
      tools: { getAccount: { risk: 'read', approval: 'never' } },
    });
    const accountsModel = fakeModel(
      { toolCalls: [{ id: 'read-account', name: 'accounts__getAccount', input: { path: { id: 42 } } }] },
      { output: 'Account 42 is active on the pro plan.' },
    );
    const support = createFevex({
      models: { demo: accountsModel },
      agents: [defineAgent({
        name: 'support', model: 'demo',
        instructions: 'Read account data through the API before answering; do not invent account state.',
        tools: ['accounts__getAccount'],
      })],
      connections: [accounts],
    });
    const accountRun = await support.runAgent('support', { input: 'What is the status and plan of account 42?' });
    const accountReply = accountsModel.calls[1]?.messages.find((message) => message.role === 'tool');
    assert(accountReply?.content, 'The model must receive the API result');
    const account = JSON.parse(accountReply.content);
    assert.deepEqual(account, { id: 42, status: 'active', plan: 'pro' });
    assert.deepEqual(accountsModel.calls[0]?.tools?.map((tool) => tool.name), ['accounts__getAccount']);
    assert(accountRun.events?.some((event) => event.type === 'tool.completed'
      && event.payload.source?.provider === 'openapi'
      && event.payload.source.connectionName === 'accounts'));
    assert.deepEqual(calls, { search: 1, getAccount: 1 });

    return {
      mcp: { answer: research.output, sources: search.matches.map(({ title, url }) => ({ title, url })) },
      openapi: { answer: accountRun.output, account },
      calls,
    };
  } finally {
    await server.stop(true);
  }
}

if (import.meta.main) console.log(JSON.stringify(await runDemo(), null, 2));
