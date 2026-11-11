import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { resolve } from 'node:path';
import { createResearchConnections, createResearchFixtures } from '../../research/agent';
import { evaluateResearch } from '../../research/evaluation';
import { createDeepSeek } from '@fevex/deepseek';
import { createOpenAI } from '@fevex/openai';
import {
  createFevex,
  createLocalSandbox,
  type Fevex,
  type ModelGateway,
  type ReasoningEffort,
  type RunId,
  type RunRecord,
  type Sandbox,
} from '@fevex/core';
import {
  createFevexHttpHandler,
  FEVEX_HTTP_PROTOCOL_VERSION,
  FEVEX_HTTP_PROTOCOL_VERSION_HEADER,
  type FevexHttpHandler,
} from '@fevex/core/http';
import {
  DemoAuthorization,
  demoAuthEnabled,
  resolveDemoContext,
} from './authorization';
import {
  mockPreviewFrameSource,
  realPreviewFrameSource,
  type PreviewFrameSource,
} from './preview.frame-source';
import { createSQLiteRunStore } from '@fevex/sqlite';
import {
  agentCatalog,
  agents,
  connections,
  contextProviders,
  memoryStore,
  tools,
  workflowCatalog,
  workflows,
} from './agents.config';

@Injectable()
export class FevexService {
  private readonly logger = new Logger(FevexService.name);
  private readonly fevex: Fevex;
  private readonly models: Record<string, ModelGateway>;
  // ponytail: single-process eval gate; use a queue if this demo becomes multi-user.
  private evaluationRunning = false;
  private readonly researchDocumentsPath = process.env.FEVEX_RESEARCH_DOCS_PATH
    ?? resolve(process.cwd(), '../../apps/web/src/content/docs/docs');
  private readonly modelCatalog: Array<{
    id: string;
    provider?: string;
    model?: string;
    efforts: ReasoningEffort[];
  }>;
  readonly http: FevexHttpHandler;
  readonly authorization = new DemoAuthorization(
    process.env.FEVEX_OWNERS_PATH ?? '.fevex/owners.json',
  );
  readonly previewFrameSource: PreviewFrameSource;

  constructor() {
    const configured = createModels();
    this.models = configured.models;
    this.modelCatalog = configured.catalog;
    const sandbox: Sandbox = createLocalSandbox({
      rootDir: process.cwd(),
      commands: [process.execPath],
      defaultTimeoutMs: 1_000,
      maxOutputBytes: 2_048,
    });
    this.previewFrameSource =
      process.env.FEVEX_BROWSER_PREVIEW === 'real'
        ? realPreviewFrameSource({
            sandbox,
            expectedVersion: process.env.FEVEX_BROWSER_VERSION ?? '0.0.0',
            network: { allow: ['*'] },
          })
        : mockPreviewFrameSource();
    const docsUrl = process.env.RESEARCH_MCP_URL;
    const accountsUrl = process.env.RESEARCH_API_URL;
    if (Boolean(docsUrl) !== Boolean(accountsUrl)) throw new Error('Set both RESEARCH_MCP_URL and RESEARCH_API_URL');
    const researchConnections = docsUrl && accountsUrl
      ? createResearchConnections({ docsUrl, accountsUrl,
          docsHeaders: process.env.RESEARCH_DOCS_TOKEN ? { authorization: `Bearer ${process.env.RESEARCH_DOCS_TOKEN}` } : undefined,
          accountsHeaders: process.env.RESEARCH_API_TOKEN ? { authorization: `Bearer ${process.env.RESEARCH_API_TOKEN}` } : undefined,
        })
      : createResearchFixtures(this.researchDocumentsPath);
    this.fevex = createFevex({
      models: configured.models,
      agents,
      workflows,
      tools,
      connections: [...connections, ...researchConnections],
      contextProviders,
      memoryStore,
      sandbox,
      runStore: createSQLiteRunStore({
        filename: process.env.FEVEX_DB_PATH ?? '.fevex/demo.sqlite',
      }),
      admission: {
        maxActiveRuns: envPositiveInteger('FEVEX_MAX_ACTIVE_RUNS', 8),
        maxActiveRunsPerTenant: envPositiveInteger('FEVEX_MAX_ACTIVE_RUNS_PER_TENANT', 4),
      },
      limits: {
        maxEventsPerRun: envPositiveInteger('FEVEX_MAX_EVENTS_PER_RUN', 10_000),
      },
    });
    const handler = createFevexHttpHandler({
      fevex: this.fevex,
      maxConnections: envPositiveInteger('FEVEX_MAX_CONNECTIONS', 64),
      authorize: (access) => this.authorization.authorize(access),
      onRunStarted: (run, context) => this.authorization.claim(run, context),
      onError: (error, problem) => {
        this.logger.error(
          `${problem.code} ${problem.instance}: ${errorMessage(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      },
    });
    this.http = createDemoHttpHandler(handler);
  }

  listAgents() {
    return agentCatalog.map(({ name, label, description, instructions, examples }) => ({
      name,
      label,
      description,
      instructions,
      examples,
    }));
  }

  listWorkflows() {
    return workflowCatalog.map(({ name, label, description, instructions, examples }) => ({
      name,
      label,
      description,
      instructions,
      examples,
    }));
  }

  listModels() {
    return this.modelCatalog;
  }

  /** Gateways registered for this runtime, including the default alias. */
  modelGateways(): Record<string, ModelGateway> {
    return { ...this.models };
  }

  async evaluateResearch(modelId: string, signal: AbortSignal) {
    if (!this.modelCatalog.some(({ id }) => id === modelId)) throw new BadRequestException('Unknown model');
    if (this.evaluationRunning) throw new ConflictException('An evaluation is already running');
    this.evaluationRunning = true;
    try {
      return await evaluateResearch(this.models[modelId]!, this.researchDocumentsPath, signal);
    } finally { this.evaluationRunning = false; }
  }

  getRun(runId: RunId): Promise<RunRecord | undefined> {
    return this.fevex.getRun(runId);
  }
}

function unauthorized(request: Request): Response {
  return new Response(JSON.stringify({
    type: 'urn:fevex:problem:unauthorized',
    title: 'Unauthorized',
    status: 401,
    code: 'UNAUTHORIZED',
    instance: new URL(request.url).pathname,
  }), {
    status: 401,
    headers: {
      'content-type': 'application/problem+json',
      'www-authenticate': 'Bearer',
      [FEVEX_HTTP_PROTOCOL_VERSION_HEADER]: FEVEX_HTTP_PROTOCOL_VERSION,
    },
  });
}

export function createDemoHttpHandler(
  handler: FevexHttpHandler,
  demoAuth: () => boolean = demoAuthEnabled,
): FevexHttpHandler {
  return async (request, handlerContext) => {
    const context = handlerContext?.context
      ?? resolveDemoContext(request.headers.get('authorization'), demoAuth());
    if (!context) return unauthorized(request);
    return handler(request, { context });
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createModels() {
  const provider = process.env.FEVEX_PROVIDER ?? 'deepseek';
  const model = process.env.FEVEX_MODEL;
  const models: Record<string, ModelGateway> = {};

  if (process.env.DEEPSEEK_API_KEY) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    models.deepseek = createDeepSeek({ apiKey, schemaPolicy: 'best-effort' })(
      process.env.DEEPSEEK_MODEL ?? (provider === 'deepseek' ? model : undefined) ?? 'deepseek-v4-flash',
    );
  }

  if (process.env.OPENAI_API_KEY) {
    const apiKey = process.env.OPENAI_API_KEY;
    models.openai = createOpenAI({
      apiKey,
      organization: process.env.OPENAI_ORG_ID,
      project: process.env.OPENAI_PROJECT_ID,
      schemaPolicy: 'best-effort'
    })(process.env.OPENAI_MODEL ?? (provider === 'openai' ? model : undefined) ?? 'gpt-5.6');
  }

  const defaultModel = models[provider];
  if (!defaultModel) {
    throw new Error(
      `Set ${provider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY'} to run the example.`,
    );
  }
  return {
    models: { default: defaultModel, ...models },
    catalog: Object.entries(models).map(([id, gateway]) => ({
      id,
      provider: gateway.metadata?.provider,
      model: gateway.metadata?.model,
      efforts: reasoningEfforts(gateway.metadata?.provider),
    })),
  };
}

function reasoningEfforts(provider: string | undefined): ReasoningEffort[] {
  return provider === 'deepseek'
    ? ['provider-default', 'none', 'low', 'high', 'xhigh', 'max']
    : ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
}
