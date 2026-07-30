import { Injectable } from '@nestjs/common';
import { createDeepSeek } from '@fevex/deepseek';
import { createOpenAI } from '@fevex/openai';
import { createFevex, createLocalSandbox, type Fevex } from '@fevex/core';
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
  private readonly fevex: Fevex;
  readonly http: FevexHttpHandler;

  constructor() {
    this.fevex = createFevex({
      models: { default: createModel() },
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
    const handler = createFevexHttpHandler({ fevex: this.fevex });
    this.http = (request) => handler(request, {
      context: {
        actor: { id: 'demo-user' },
        attributes: { plan: 'pro', region: 'MX' },
      },
    });
  }

  listAgents() {
    return agentCatalog.map(({ name, label, description }) => ({ name, label, description }));
  }

  listWorkflows() {
    return workflowCatalog.map(({ name, label, description }) => ({ name, label, description }));
  }

}

function createModel() {
  const provider = process.env.FEVEX_PROVIDER ?? 'deepseek';
  const model = process.env.FEVEX_MODEL;

  if (provider === 'deepseek') {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('Set DEEPSEEK_API_KEY to run the DeepSeek example.');
    return createDeepSeek({ apiKey, schemaPolicy: 'best-effort' })(
      model ?? 'deepseek-v4-flash',
    );
  }

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('Set OPENAI_API_KEY to run the OpenAI example.');
    return createOpenAI({
      apiKey,
      organization: process.env.OPENAI_ORG_ID,
      project: process.env.OPENAI_PROJECT_ID,
      schemaPolicy: 'best-effort',
    })(model ?? 'gpt-5.6');
  }

  throw new Error('FEVEX_PROVIDER must be "deepseek" or "openai".');
}
