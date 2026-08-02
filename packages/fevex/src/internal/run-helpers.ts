import type { AgentMessage, ExecutionContext, JsonObject, JsonValue } from '../core';
import type { ContextBlock, KnowledgeContext, MemoryStore } from '../knowledge';
import type { ToolChoice } from '../models';
import { RunPausedError } from '../run-error';
import type { AgentRunPause, CoordinatorRun, ResumeRunResolution, RunRecord, TeamRun } from '../runtime';
import { IntegrationError, validateFevexJsonSchemaProfile, type ToolDefinition } from '../tools';
import type { FevexComposition } from './configuration';
import { abortable } from './run-support';
import { ELICIT_TOOL_NAME } from './runtime-constants';

type RegisteredAgent = FevexComposition['agents'] extends Map<string, infer T> ? T : never;

export function redact(message: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (safe, secret) => (secret ? safe.split(secret).join('[REDACTED]') : safe),
    message,
  );
}

export function containsSecret(value: JsonValue, secrets: readonly string[]): boolean {
  if (typeof value === 'string') return secrets.some((secret) => secret && value.includes(secret));
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, secrets));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsSecret(item, secrets));
  }
  return false;
}

export function effectiveElicitationMode(
  agent: { elicitation?: 'pause' | 'forbid' },
  request: { elicitation?: 'pause' | 'forbid' },
) {
  return request.elicitation ?? agent.elicitation ?? 'forbid';
}

export function effectiveApprovalMode(
  agent: { approvalMode?: 'pause' | 'deny' },
  request: { approvalMode?: 'pause' | 'deny' },
) {
  return request.approvalMode ?? agent.approvalMode ?? 'pause';
}

export function effectiveToolChoice(
  agent: { toolChoice?: ToolChoice },
  request: { toolChoice?: ToolChoice },
) {
  return request.toolChoice ?? agent.toolChoice ?? 'auto';
}

export function isElicitationToolCall(call: { name: string }) {
  return call.name === ELICIT_TOOL_NAME;
}

export function readElicitationInput(input: JsonValue): {
  prompt: string;
  responseSchema: JsonObject;
  expiresAt?: string;
} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Elicitation input must be an object');
  }
  const prompt = input.prompt;
  const responseSchema = input.responseSchema;
  const expiresAt = input.expiresAt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('Elicitation prompt must be a non-empty string');
  }
  if (typeof responseSchema !== 'object' || responseSchema === null || Array.isArray(responseSchema)) {
    throw new TypeError('Elicitation responseSchema must be an object');
  }
  validateFevexJsonSchemaProfile(responseSchema);
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
      throw new TypeError('Elicitation expiresAt must be a valid ISO date string');
    }
  }
  return {
    prompt,
    responseSchema,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export function isCoordinatorRun(run: RunRecord): run is CoordinatorRun {
  return run.kind === 'workflow' || run.kind === 'team';
}

export function isTeamRun(run: RunRecord): run is TeamRun {
  return run.kind === 'team';
}

export function coordinatorName(run: CoordinatorRun): string {
  return run.kind === 'team' ? run.teamName : run.workflowName;
}

export class WorkflowChildPausedError extends Error {
  constructor(
    readonly stepId: string,
    readonly paused: RunPausedError,
  ) {
    super(paused.message, { cause: paused });
  }
}

export function pauseMatchesResolution(
  pause: AgentRunPause,
  resolution: ResumeRunResolution,
): boolean {
  if (pause.type === 'elicitation' && resolution.type === 'elicitation') {
    return pause.request.id === resolution.requestId;
  }
  if (pause.type === 'approval' && resolution.type === 'approval') {
    return pause.approval.id === resolution.approvalId;
  }
  if (pause.type === 'tool_execution_unknown' && resolution.type === 'tool_execution') {
    return pause.toolCallId === resolution.toolCallId;
  }
  return false;
}

export function mergeExecutionContext(
  parent: ExecutionContext | undefined,
  child: ExecutionContext | undefined,
): ExecutionContext | undefined {
  if (!parent) return child;
  if (!child) return parent;
  return {
    ...parent,
    ...child,
    actor: parent.actor ?? child.actor,
    ...(parent.attributes || child.attributes
      ? { attributes: { ...parent.attributes, ...child.attributes } }
      : {}),
    ...(parent.prompt || child.prompt ? { prompt: { ...parent.prompt, ...child.prompt } } : {}),
  };
}

export function systemBlock(label: string, provider: string, block: ContextBlock): AgentMessage {
  return {
    role: 'system',
    content: `[${label}: ${provider}/${block.id}]\n${block.content}`,
  };
}

export async function readMemoryMessages(
  agent: RegisteredAgent,
  context: KnowledgeContext,
  memoryStore: MemoryStore | undefined,
): Promise<AgentMessage[]> {
  if (!agent.memory || agent.memory.read === false || !memoryStore) return [];
  try {
    const records = await abortable(
      () =>
        memoryStore.search(
          {
            query: context.input,
            limit: agent.memory?.limit ?? 5,
            agentName: context.agentName,
            sessionId: context.sessionId,
            namespace: context.context?.namespace,
            actor: context.context?.actor,
          },
          context,
        ),
      context.signal!,
    );
    return records
      .filter((record) => record.content.trim())
      .map((record) => ({
        role: 'system',
        content: `[Memory: ${record.id}]\n${record.content}`,
      }));
  } catch (cause) {
    throw new Error('Memory search failed', { cause });
  }
}

export const toolSourcePayload = (tool: ToolDefinition, error?: unknown) => {
  const source = error instanceof IntegrationError ? error.source ?? tool.source : tool.source;
  return source === undefined ? {} : { source };
};

export const toolLabelPayload = (tool: ToolDefinition) =>
  tool.label === undefined ? {} : { toolLabel: tool.label };

export const toolErrorPayload = (tool: ToolDefinition, error: unknown) => ({
  ...toolSourcePayload(tool, error),
  ...(error instanceof IntegrationError
    ? { errorCode: error.code, retryable: error.retryable }
    : {}),
});

export const runErrorPayload = (error: unknown) => {
  if (!(error instanceof IntegrationError)) return {};
  return {
    errorCode: error.code,
    retryable: error.retryable,
    ...(error.source === undefined ? {} : { source: error.source }),
  };
};
