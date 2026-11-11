import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChannelMessage } from '@fevex/core/channels';
import { createFevex, defineConnection } from '@fevex/core';
import { createDeepSeek } from '@fevex/deepseek';
import { createMcpToolProvider } from '@fevex/mcp';
import { createOpenAI } from '@fevex/openai';
import {
  createSlackAdapter,
  handleSlackWebhook,
  type SlackDelivery,
  type SlackWebhookResponse,
} from '@fevex/slack';
import { createSQLiteChannelStore, createSQLiteRunStore } from '@fevex/sqlite';
import { supportAgent } from './agent';
import { startMcpFixtureServer } from './mcp-server';
import { createEnvironmentModel, createScriptedModel, createSwitchableModel } from './model';
import { createSlackSimulator, type SimulatedRun } from './simulator';
import { chatHtml } from './ui';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

function sessionKey(message: ChannelMessage): string {
  const team = typeof message.metadata?.teamId === 'string' ? `${message.metadata.teamId}:` : '';
  return `${team}${message.threadId ?? message.conversationId}`;
}

function loadSessions(path: string): Map<string, string> {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Slack session file ${path} must contain a JSON object`);
    }
    return new Map(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return new Map();
    throw error;
  }
}

function saveSessions(path: string, sessions: Map<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(sessions), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Slack request failed';
}

export async function startServer() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('PORT must be an integer between 1 and 65535');
  }
  const simulate = process.env.FEVEX_SLACK_SIMULATE === '1'
    || !process.env.SLACK_SIGNING_SECRET
    || !process.env.SLACK_BOT_TOKEN;
  const signingSecret = simulate
    ? (process.env.SLACK_SIGNING_SECRET || 'simulated-secret')
    : required('SLACK_SIGNING_SECRET');
  const botToken = simulate
    ? (process.env.SLACK_BOT_TOKEN || 'simulated-token')
    : required('SLACK_BOT_TOKEN');
  const botUserId = simulate ? 'UBOT' : process.env.SLACK_BOT_USER_ID;

  const dataDirectory = process.env.FEVEX_DATA_DIR ?? '.fevex';
  const database = process.env.FEVEX_SLACK_DB ?? join(dataDirectory, 'slack.sqlite');
  const sessionsPath = process.env.FEVEX_SLACK_SESSIONS ?? join(dataDirectory, 'sessions.json');
  const sessions = loadSessions(sessionsPath);
  const initialModel = simulate ? { model: createScriptedModel(), provider: 'scripted' } : createEnvironmentModel();
  const switchable = createSwitchableModel(initialModel.model);
  let provider = initialModel.provider;

  const mcpFixture = process.env.FEVEX_MCP_URL ? undefined : startMcpFixtureServer();
  const mcpUrl = process.env.FEVEX_MCP_URL ?? mcpFixture!.url;
  const accounts = defineConnection({
    name: 'accounts',
    provider: createMcpToolProvider({ url: mcpUrl, requestTimeoutMs: 5_000 }),
    allowlist: ['accounts_get', 'accounts_list'],
    tools: {
      accounts_get: { risk: 'read', approval: 'never' },
      accounts_list: { risk: 'read', approval: 'never' },
    },
  });

  const runStore = createSQLiteRunStore({ filename: database });
  const channelStore = createSQLiteChannelStore<SlackDelivery>({ filename: database });
  const app = createFevex({
    models: { default: switchable.gateway },
    agents: [supportAgent],
    connections: [accounts],
    runStore,
  });
  const adapter = createSlackAdapter({
    signingSecret,
    botToken,
    ...(botUserId ? { botUserId } : {}),
    ...(simulate ? { apiUrl: `http://127.0.0.1:${port}/slack-api/chat.postMessage` } : {}),
    store: channelStore,
  });

  const remember = (run: SimulatedRun): void => {
    sessions.set(sessionKey(run.message), run.run.sessionId);
    saveSessions(sessionsPath, sessions);
  };
  const resolveSessionId = (message: ChannelMessage) => sessions.get(sessionKey(message));
  const webhookOptions = {
    fevex: app,
    adapter,
    agentName: supportAgent.name,
    resolveSessionId,
  };
  const simulator = simulate
    ? createSlackSimulator({
      secret: signingSecret,
      ...webhookOptions,
      onRun: remember,
    })
    : undefined;

  async function configureModel(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as {
      provider?: unknown;
      apiKey?: unknown;
      model?: unknown;
    } | undefined;
    const kind = body?.provider;
    if (kind === 'scripted') {
      switchable.use(createScriptedModel());
      provider = 'scripted';
      return Response.json({ provider, model: 'scripted' });
    }
    if (kind !== 'openai' && kind !== 'deepseek') {
      return Response.json({ error: 'provider must be scripted, openai or deepseek' }, { status: 400 });
    }
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    const modelId = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!apiKey || !modelId) {
      return Response.json({ error: 'API key and model are required' }, { status: 400 });
    }
    try {
      switchable.use(kind === 'openai'
        ? createOpenAI({ apiKey, schemaPolicy: 'best-effort' })(modelId)
        : createDeepSeek({ apiKey, schemaPolicy: 'best-effort' })(modelId));
      provider = `${kind}:${modelId}`;
      return Response.json({ provider: kind, model: modelId });
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 400 });
    }
  }

  const server = Bun.serve({
    hostname: '0.0.0.0',
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        return Response.json({ ok: true, mode: simulate ? 'simulate' : 'slack', provider });
      }
      if (simulate) {
        if (url.pathname === '/' && request.method === 'GET') {
          return new Response(chatHtml, {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        if (url.pathname === '/api/config') {
          if (request.method === 'GET') return Response.json({ provider });
          if (request.method === 'POST') return configureModel(request);
          return new Response('method not allowed', { status: 405 });
        }
        if (url.pathname === '/api/simulate' && request.method === 'POST') {
          return simulator!.handleSimulate(request);
        }
        const fakeApi = await simulator!.handleFakeApi(request);
        if (fakeApi) return fakeApi;
      }
      if (url.pathname !== '/slack/events') return new Response('not found', { status: 404 });
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

      try {
        const result: SlackWebhookResponse = await handleSlackWebhook(
          { headers: request.headers, body: await request.text() },
          webhookOptions,
        );
        if (result.done) {
          void result.done.then((run) => {
            if (!run.ignored) remember(run);
          }).catch((error) => {
            console.error('Slack run failed', errorMessage(error));
          });
        }
        return new Response(result.body, {
          status: result.status,
          headers: result.status === 200 && result.body
            ? { 'content-type': 'application/json' }
            : undefined,
        });
      } catch (error) {
        console.error('Slack webhook failed', errorMessage(error));
        return new Response('internal error', { status: 500 });
      }
    },
  });

  console.log(JSON.stringify({
    url: `http://localhost:${server.port}`,
    mode: simulate ? 'simulate' : 'slack',
    events: '/slack/events',
    health: '/health',
    provider,
    mcp: mcpUrl.toString(),
    database,
    sessions: sessionsPath,
  }));

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop(true);
    await mcpFixture?.close();
    await channelStore.close();
    await runStore.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown().then(
        () => process.exit(0),
        (error) => {
          console.error('Slack shutdown failed', errorMessage(error));
          process.exit(1);
        },
      );
    });
  }

  return { server, app, adapter, channelStore, runStore, mcpFixture, shutdown };
}

if (import.meta.main) await startServer();
