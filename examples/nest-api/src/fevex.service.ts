import { Injectable, NotFoundException } from '@nestjs/common';
import { createDeepSeek } from '@fevex/deepseek';
import { createFevex, type AgentEvent, type Fevex } from '@fevex/core';
import { agentCatalog, agents, tools } from './agents.config';

@Injectable()
export class FevexService {
  private readonly fevex: Fevex;

  constructor() {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('Set DEEPSEEK_API_KEY to run the Nest API example.');

    this.fevex = createFevex({
      models: {
        default: createDeepSeek({
          apiKey,
          schemaPolicy: 'best-effort',
        })('deepseek-v4-flash'),
      },
      agents,
      tools,
    });
  }

  listAgents() {
    return agentCatalog.map(({ name, label, description }) => ({ name, label, description }));
  }

  async runAgent(name: string, input: string) {
    if (!agentCatalog.some((agent) => agent.name === name)) {
      throw new NotFoundException(`Agent "${name}" not found.`);
    }

    const result = await this.fevex.runAgent<string, string>(name, { input });
    return result.output;
  }

  streamAgent(name: string, input: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    if (!agentCatalog.some((agent) => agent.name === name)) {
      throw new NotFoundException(`Agent "${name}" not found.`);
    }

    return this.fevex.streamAgent<string, string>(name, { input, signal });
  }
}
