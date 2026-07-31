import { Injectable, Logger } from '@nestjs/common';
import { createDeepSeek } from '@fevex/deepseek';
import { createOpenAI } from '@fevex/openai';
import {
  createFevex,
  createLocalSandbox,
  type Fevex,
  type ModelGateway,
  type ReasoningEffort,
} from '@fevex/core';
import { createFevexHttpHandler, type FevexHttpHandler } from '@fevex/core/http';
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
  private readonly modelCatalog: Array<{
    id: string;
    provider?: string;
    model?: string;
    efforts: ReasoningEffort[];
  }>;
  readonly http: FevexHttpHandler;

  constructor() {
    const configured = createModels();
    this.modelCatalog = configured.catalog;
    this.fevex = createFevex({
      models: configured.models,
      agents,
      workflows,
      tools,
      connections,
      contextProviders,
      memoryStore,
      sandbox: createLocalSandbox({
        rootDir: process.cwd(),
        commands: [process.execPath],
        defaultTimeoutMs: 1_000,
        maxOutputBytes: 2_048,
      }),
      runStore: createSQLiteRunStore({
        filename: process.env.FEVEX_DB_PATH ?? '.fevex/demo.sqlite',
      }),
    });
    const handler = createFevexHttpHandler({
      fevex: this.fevex,
      onError: (error, problem) => {
        this.logger.error(
          `${problem.code} ${problem.instance}: ${errorMessage(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      },
    });
    this.http = (request) => handler(request, {
      context: {
        actor: { id: 'demo-user' },
        attributes: { plan: 'pro', region: 'MX' },
      },
    });
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
