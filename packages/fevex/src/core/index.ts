export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type RunId = string;

export const SCHEMA_NOT_TRANSPORTABLE = 'SCHEMA_NOT_TRANSPORTABLE';

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
  | 'model.completed'
  | 'tool.completed'
  | 'tool.failed'
  | 'run.completed'
  | 'run.failed';

export interface AgentEvent<TPayload extends JsonValue = JsonObject> {
  type: AgentEventType;
  runId: RunId;
  timestamp: string;
  payload?: TPayload;
}
