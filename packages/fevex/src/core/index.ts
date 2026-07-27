export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type RunId = string;

export const SCHEMA_NOT_TRANSPORTABLE = 'SCHEMA_NOT_TRANSPORTABLE';
export const PROVIDER_SCHEMA_UNSUPPORTED = 'PROVIDER_SCHEMA_UNSUPPORTED';
export const PROVIDER_REASONING_UNSUPPORTED = 'PROVIDER_REASONING_UNSUPPORTED';

export interface ExecutionContext {
  namespace?: string;
  actor?: { id: string; type?: string };
  attributes?: JsonObject;
  prompt?: JsonObject;
}

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
}

export type AgentEventType =
  | 'run.started'
  | 'run.paused'
  | 'run.resumed'
  | 'model.started'
  | 'model.output.delta'
  | 'model.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.retrying'
  | 'tool.execution_unknown'
  | 'approval.requested'
  | 'approval.resolved'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export interface AgentEventPayloads {
  'run.started': undefined;
  'run.paused': { reason: 'approval' | 'tool_execution_unknown'; toolCallId: string };
  'run.resumed': undefined;
  'model.started': { step: number };
  'model.output.delta': { step: number; delta: string };
  'model.completed': { step: number; usage?: JsonObject };
  'tool.started': { step: number; toolCallId: string; toolName: string; attempt?: number };
  'tool.completed': { step: number; toolCallId: string; toolName: string; attempt?: number };
  'tool.failed': { step: number; toolCallId: string; toolName: string; error: string };
  'tool.retrying': {
    step: number;
    toolCallId: string;
    toolName: string;
    attempt: number;
    delayMs: number;
    error: string;
  };
  'tool.execution_unknown': { step: number; toolCallId: string; toolName: string };
  'approval.requested': { approvalId: string; toolCallId: string; toolName: string };
  'approval.resolved': {
    approvalId: string;
    toolCallId: string;
    decision: 'approve' | 'reject';
    actorId: string;
  };
  'run.completed': { output: JsonValue; usage?: JsonObject };
  'run.failed': { error: string };
  'run.cancelled': { reason: 'aborted' | 'timeout' | 'approval_rejected' };
}

interface AgentEventBase {
  id: string;
  sequence: number;
  runId: RunId;
  timestamp: string;
}

export type AgentEvent<TType extends AgentEventType = AgentEventType> = {
  [TCurrent in TType]: AgentEventBase & {
    type: TCurrent;
  } & (AgentEventPayloads[TCurrent] extends undefined
      ? { payload?: never }
      : { payload: AgentEventPayloads[TCurrent] });
}[TType];
