import type { JsonObject } from '../core';
import type { ToolDefinition } from '../tools';
import type { TeamDefinition } from '../teams';
import type { FevexComposition } from './configuration';
import { toTransportableSchema } from './schemas';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

async function transportableTool(
  tool: ToolDefinition,
): Promise<{
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  risk: string;
  approval: string;
  idempotency: string;
  retry: ToolDefinition['retry'];
  credentials: string[];
  sandbox: ToolDefinition['sandbox'];
  source: ToolDefinition['source'];
}> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema:
      tool.inputJsonSchema ??
      (tool.inputSchema === undefined
        ? undefined
        : toTransportableSchema(
            tool.inputSchema,
            'input',
            `Input schema for tool "${tool.name}" is not transportable`,
          )),
    outputSchema:
      tool.outputJsonSchema ??
      (tool.outputSchema === undefined
        ? undefined
        : toTransportableSchema(
            tool.outputSchema,
            'output',
            `Output schema for tool "${tool.name}" is not transportable`,
          )),
    risk: tool.risk ?? 'read',
    approval: tool.approval ?? 'never',
    idempotency: tool.idempotency ?? 'none',
    retry: tool.retry,
    credentials: tool.credentials ?? [],
    sandbox: tool.sandbox,
    source: tool.source,
  };
}

async function sha256(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function definitionHash(
  name: string,
  modelName: string,
  agent: FevexComposition['agents'] extends Map<string, infer T> ? T : never,
  tools: Map<string, ToolDefinition>,
): Promise<string> {
  const toolDefinitions = await Promise.all(
    (agent.tools ?? []).map((toolName) => transportableTool(tools.get(toolName)!)),
  );
  return sha256({
    name,
    modelName,
    instructions: agent.instructions,
    context: agent.context,
    memory: agent.memory,
    skills: agent.skills,
    tools: toolDefinitions,
    reasoning: agent.reasoning,
    modelOptions: agent.modelOptions,
    toolChoice: agent.toolChoice,
    elicitation: agent.elicitation,
    approvalMode: agent.approvalMode,
    limits: agent.limits,
    inputSchema:
      agent.inputSchema === undefined
        ? undefined
        : toTransportableSchema(
            agent.inputSchema,
            'input',
            `Input schema for agent "${name}" is not transportable`,
          ),
    outputSchema:
      agent.outputSchema === undefined
        ? undefined
        : toTransportableSchema(
            agent.outputSchema,
            'output',
            `Output schema for agent "${name}" is not transportable`,
          ),
  });
}

export function workflowDefinitionHash(
  name: string,
  workflow: FevexComposition['workflows'] extends Map<string, infer T> ? T : never,
): Promise<string> {
  // Hash the declared surface, not run.toString(): minification changes source
  // while closed-over business logic can change without changing that string.
  return sha256({
    name,
    version: workflow.version ?? '1',
    limits: workflow.limits,
    inputSchema:
      workflow.inputSchema === undefined
        ? undefined
        : toTransportableSchema(
            workflow.inputSchema,
            'input',
            `Input schema for workflow "${name}" is not transportable`,
          ),
    outputSchema:
      workflow.outputSchema === undefined
        ? undefined
        : toTransportableSchema(
            workflow.outputSchema,
            'output',
            `Output schema for workflow "${name}" is not transportable`,
          ),
    events: Object.fromEntries(
      Object.entries(workflow.events ?? {}).map(([eventName, event]) => [
        eventName,
        {
          requireActor: event.requireActor ?? false,
          payloadSchema:
            event.payloadSchema === undefined
              ? undefined
              : toTransportableSchema(
                  event.payloadSchema,
                  'input',
                  `Payload schema for workflow "${name}" event "${eventName}" is not transportable`,
                ),
        },
      ]),
    ),
  });
}

export function teamDefinitionHash(name: string, team: TeamDefinition): Promise<string> {
  return sha256({
    name,
    version: team.version ?? '1',
    supervisor: team.supervisor,
    members: team.members,
    limits: team.limits,
    inputSchema:
      team.inputSchema === undefined
        ? undefined
        : toTransportableSchema(
            team.inputSchema,
            'input',
            `Input schema for team "${name}" is not transportable`,
          ),
    outputSchema:
      team.outputSchema === undefined
        ? undefined
        : toTransportableSchema(
            team.outputSchema,
            'output',
            `Output schema for team "${name}" is not transportable`,
          ),
  });
}
