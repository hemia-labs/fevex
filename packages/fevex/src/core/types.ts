/** A value that can cross provider and persistence boundaries without conversion. */
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

export interface ToolEventSource {
  kind: 'connection';
  provider: string;
  connectionName: string;
  remoteToolName: string;
}

export type AgentEventType =
  | 'run.started'
  | 'run.recovered'
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
  | 'elicitation.requested'
  | 'elicitation.resolved'
  | 'approval.requested'
  | 'approval.resolved'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'workflow.run.started'
  | 'workflow.run.recovered'
  | 'workflow.step.started'
  | 'workflow.step.completed'
  | 'workflow.step.failed'
  | 'workflow.compensation.started'
  | 'workflow.compensation.completed'
  | 'workflow.compensation.failed'
  | 'workflow.wait.started'
  | 'workflow.wait.completed'
  | 'workflow.run.paused'
  | 'workflow.run.resumed'
  | 'workflow.run.completed'
  | 'workflow.run.failed'
  | 'workflow.run.cancelled'
  | 'team.run.started'
  | 'team.run.recovered'
  | 'team.agent.assigned'
  | 'team.handoff.created'
  | 'team.task.completed'
  | 'team.task.failed'
  | 'team.merge.started'
  | 'team.merge.completed'
  | 'team.merge.failed'
  | 'team.run.paused'
  | 'team.run.resumed'
  | 'team.run.completed'
  | 'team.run.failed'
  | 'team.run.cancelled';

export interface AgentEventPayloads {
  'run.started': undefined;
  'run.recovered': { actorId: string };
  'run.paused': {
    reason: 'elicitation' | 'approval' | 'tool_execution_unknown';
    toolCallId: string;
  };
  'run.resumed': undefined;
  'model.started': {
    step: number;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'model.output.delta': {
    step: number;
    delta: string;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'model.completed': {
    step: number;
    usage?: JsonObject;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'tool.started': {
    step: number;
    toolCallId: string;
    toolName: string;
    attempt?: number;
    source?: ToolEventSource;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'tool.completed': {
    step: number;
    toolCallId: string;
    toolName: string;
    attempt?: number;
    source?: ToolEventSource;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'tool.failed': {
    step: number;
    toolCallId: string;
    toolName: string;
    error: string;
    errorCode?: string;
    retryable?: boolean;
    source?: ToolEventSource;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'tool.retrying': {
    step: number;
    toolCallId: string;
    toolName: string;
    attempt: number;
    delayMs: number;
    error: string;
    errorCode?: string;
    retryable?: boolean;
    source?: ToolEventSource;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'tool.execution_unknown': {
    step: number;
    toolCallId: string;
    toolName: string;
    source?: ToolEventSource;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'elicitation.requested': {
    request: {
      id: string;
      toolCallId: string;
      prompt: string;
      responseSchema: JsonObject;
      requestedAt: string;
      expiresAt?: string;
    };
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'elicitation.resolved': {
    requestId: string;
    toolCallId: string;
    actorId: string;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'approval.requested': {
    approvalId: string;
    toolCallId: string;
    toolName: string;
    source?: ToolEventSource;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'approval.resolved': {
    approvalId: string;
    toolCallId: string;
    decision: 'approve' | 'reject';
    actorId: string;
    source?: ToolEventSource;
    workflowStepId?: string;
    workflowAgentName?: string;
    teamDelegationId?: string;
    teamAgentName?: string;
  };
  'run.completed': { output: JsonValue; usage?: JsonObject };
  'run.failed': { error: string; errorCode?: string; retryable?: boolean; source?: ToolEventSource };
  'run.cancelled': { reason: 'aborted' | 'timeout' | 'approval_rejected' };
  'workflow.run.started': undefined;
  'workflow.run.recovered': { actorId: string };
  'workflow.step.started': { stepId: string; kind: 'agent' | 'parallel'; agentName?: string };
  'workflow.step.completed': { stepId: string; kind: 'agent' | 'parallel' };
  'workflow.step.failed': { stepId: string; kind: 'agent' | 'parallel'; error: string };
  'workflow.compensation.started': { stepId: string; kind: 'agent' | 'parallel' };
  'workflow.compensation.completed': { stepId: string; kind: 'agent' | 'parallel' };
  'workflow.compensation.failed': { stepId: string; kind: 'agent' | 'parallel'; error: string };
  'workflow.wait.started': {
    stepId: string;
    kind: 'timer' | 'event';
    resumeAt?: string;
    eventName?: string;
  };
  'workflow.wait.completed': {
    stepId: string;
    kind: 'timer' | 'event';
    payload?: JsonValue;
    actorId?: string;
    receivedAt?: string;
  };
  'workflow.run.paused': {
    stepId: string;
    reason: 'child' | 'timer' | 'event';
    childRunId?: string;
  };
  'workflow.run.resumed': undefined;
  'workflow.run.completed': { output: JsonValue; usage?: JsonObject };
  'workflow.run.failed': { error: string; errorCode?: string; retryable?: boolean; source?: ToolEventSource };
  'workflow.run.cancelled': { reason: 'aborted' | 'timeout' | 'approval_rejected' };
  'team.run.started': undefined;
  'team.run.recovered': { actorId: string };
  'team.agent.assigned': {
    delegationId: string;
    agentName: string;
    action: 'delegate' | 'handoff';
    expectedOutput?: string;
    constraints?: string[];
  };
  'team.handoff.created': {
    delegationId: string;
    from: string;
    to: string;
    reason: string;
  };
  'team.task.completed': {
    delegationId: string;
    agentName: string;
    usage?: JsonObject;
  };
  'team.task.failed': { delegationId: string; agentName?: string; error: string };
  'team.merge.started': { stepId: string; width: number };
  'team.merge.completed': { stepId: string };
  'team.merge.failed': { stepId: string; error: string };
  'team.run.paused': {
    delegationId: string;
    reason: 'child' | 'timer' | 'event';
    childRunId?: string;
  };
  'team.run.resumed': undefined;
  'team.run.completed': { output: JsonValue; usage?: JsonObject };
  'team.run.failed': {
    error: string;
    errorCode?: string;
    retryable?: boolean;
    source?: ToolEventSource;
  };
  'team.run.cancelled': { reason: 'aborted' | 'timeout' | 'approval_rejected' };
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
