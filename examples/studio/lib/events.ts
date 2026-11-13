import type { AgentEvent } from '@fevex/core';
import { previewValue, type Tone } from './format';

export interface ToolActivity {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'retrying' | 'unknown';
  attempt?: number;
  error?: string;
  errorCode?: string;
  source?: string;
  startedAt: string;
  updatedAt: string;
}

export interface RunFailure {
  id: string;
  source: string;
  message: string;
  code?: string;
  timestamp: string;
}

export interface RunSummary {
  tools: ToolActivity[];
  failures: RunFailure[];
  output: string;
  lastEventAt?: string;
}

export interface TimelineEntry {
  id: string;
  type: string;
  timestamp: string;
  title: string;
  detail?: string;
  severity: Tone;
  count: number;
  payload?: unknown;
}

export function summarizeRun(events: AgentEvent[]): RunSummary {
  const tools = new Map<string, ToolActivity>();
  const failures: RunFailure[] = [];
  let output = '';
  let outputStep: number | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'model.output.delta': {
        if (outputStep !== undefined && outputStep !== event.payload.step) output += '\n\n';
        outputStep = event.payload.step;
        output += event.payload.delta;
        break;
      }
      case 'tool.started': {
        const source = event.payload.source
          ? `${event.payload.source.connectionName}/${event.payload.source.remoteToolName}`
          : undefined;
        tools.set(event.payload.toolCallId, {
          id: event.payload.toolCallId,
          name: event.payload.toolName,
          status: 'running',
          attempt: event.payload.attempt,
          source,
          startedAt: event.timestamp,
          updatedAt: event.timestamp,
        });
        break;
      }
      case 'tool.completed': {
        updateTool(tools, event.payload.toolCallId, event.payload.toolName, event.timestamp, {
          status: 'completed',
          attempt: event.payload.attempt,
        });
        break;
      }
      case 'tool.failed': {
        updateTool(tools, event.payload.toolCallId, event.payload.toolName, event.timestamp, {
          status: 'failed',
          error: event.payload.error,
          errorCode: event.payload.errorCode,
        });
        failures.push({
          id: event.id,
          source: `tool:${event.payload.toolName}`,
          message: event.payload.error,
          code: event.payload.errorCode,
          timestamp: event.timestamp,
        });
        break;
      }
      case 'tool.retrying': {
        updateTool(tools, event.payload.toolCallId, event.payload.toolName, event.timestamp, {
          status: 'retrying',
          error: event.payload.error,
          errorCode: event.payload.errorCode,
          attempt: event.payload.attempt,
        });
        break;
      }
      case 'tool.execution_unknown': {
        updateTool(tools, event.payload.toolCallId, event.payload.toolName, event.timestamp, {
          status: 'unknown',
        });
        break;
      }
      case 'run.failed':
      case 'workflow.run.failed':
      case 'team.run.failed': {
        failures.push({
          id: event.id,
          source: 'run',
          message: event.payload.error,
          code: event.payload.errorCode,
          timestamp: event.timestamp,
        });
        break;
      }
      case 'workflow.step.failed': {
        failures.push({
          id: event.id,
          source: `workflow:${event.payload.stepId}`,
          message: event.payload.error,
          timestamp: event.timestamp,
        });
        break;
      }
      case 'workflow.compensation.failed': {
        failures.push({
          id: event.id,
          source: `compensation:${event.payload.stepId}`,
          message: event.payload.error,
          timestamp: event.timestamp,
        });
        break;
      }
      case 'team.task.failed': {
        failures.push({
          id: event.id,
          source: `team:${event.payload.agentName ?? event.payload.delegationId}`,
          message: event.payload.error,
          timestamp: event.timestamp,
        });
        break;
      }
      case 'team.merge.failed': {
        failures.push({
          id: event.id,
          source: `team-merge:${event.payload.stepId}`,
          message: event.payload.error,
          timestamp: event.timestamp,
        });
        break;
      }
    }
  }

  return {
    tools: [...tools.values()],
    failures,
    output,
    ...(events.length === 0 ? {} : { lastEventAt: events[events.length - 1]!.timestamp }),
  };
}

function updateTool(
  tools: Map<string, ToolActivity>,
  id: string,
  name: string,
  timestamp: string,
  patch: Partial<ToolActivity>,
): void {
  const current = tools.get(id);
  tools.set(id, {
    id,
    name,
    startedAt: current?.startedAt ?? timestamp,
    updatedAt: timestamp,
    status: 'running',
    ...current,
    ...patch,
  });
}

export function buildTimeline(events: AgentEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let delta: TimelineEntry | undefined;

  for (const event of events) {
    if (event.type === 'model.output.delta') {
      const step = event.payload.step;
      if (!delta || (delta.payload as { step: number }).step !== step) {
        delta = {
          id: event.id,
          type: event.type,
          timestamp: event.timestamp,
          title: titleForType(event.type),
          severity: 'neutral',
          count: 0,
          payload: { step, text: '' },
        };
        entries.push(delta);
      }
      const payload = delta.payload as { step: number; text: string };
      payload.text += event.payload.delta;
      delta.detail = payload.text;
      delta.count += 1;
      delta.id = event.id;
      delta.timestamp = event.timestamp;
      continue;
    }

    delta = undefined;
    entries.push({
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      title: titleForType(event.type),
      detail: detailFor(event),
      severity: severityFor(event),
      count: 1,
      payload: (event as { payload?: unknown }).payload,
    });
  }

  return entries;
}

export function titleForType(type: string): string {
  const known: Record<string, string> = {
    'run.started': 'Run iniciado',
    'run.recovered': 'Run recuperado',
    'run.paused': 'Run pausado',
    'run.resumed': 'Run reanudado',
    'run.completed': 'Run completado',
    'run.failed': 'Run falló',
    'run.cancelled': 'Run cancelado',
    'model.started': 'Modelo iniciado',
    'model.completed': 'Modelo completado',
    'model.output.delta': 'Salida del modelo',
    'tool.started': 'Tool iniciada',
    'tool.completed': 'Tool completada',
    'tool.failed': 'Tool falló',
    'tool.retrying': 'Reintentando tool',
    'tool.execution_unknown': 'Tool con ejecución incierta',
    'approval.requested': 'Approval solicitada',
    'approval.resolved': 'Approval resuelta',
    'elicitation.requested': 'Elicitation solicitada',
    'elicitation.resolved': 'Elicitation resuelta',
    'policy.evaluated': 'Política evaluada',
    'artifact.created': 'Artefacto creado',
    'context.compacted': 'Contexto compactado',
    'memory.completed': 'Memoria actualizada',
  };
  if (known[type]) return known[type]!;
  return type
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function severityFor(event: AgentEvent): Tone {
  if (event.type.endsWith('failed') || event.type === 'tool.failed') return 'danger';
  if (
    event.type === 'run.completed' ||
    event.type === 'workflow.run.completed' ||
    event.type === 'team.run.completed' ||
    event.type === 'tool.completed' ||
    (event.type === 'approval.resolved' && event.payload.decision === 'approve')
  ) {
    return 'success';
  }
  if (
    event.type.endsWith('paused') ||
    event.type === 'approval.requested' ||
    event.type === 'elicitation.requested' ||
    event.type === 'tool.retrying' ||
    event.type === 'tool.execution_unknown' ||
    (event.type === 'approval.resolved' && event.payload.decision === 'reject') ||
    event.type === 'run.cancelled' ||
    event.type === 'workflow.run.cancelled' ||
    event.type === 'team.run.cancelled'
  ) {
    return 'warning';
  }
  if (event.type.endsWith('.started') || event.type.endsWith('.resumed') || event.type.endsWith('.recovered')) {
    return 'info';
  }
  return 'neutral';
}

function detailFor(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'run.paused':
      return event.payload.reason;
    case 'run.failed':
    case 'workflow.run.failed':
    case 'team.run.failed':
      return event.payload.error;
    case 'run.cancelled':
    case 'workflow.run.cancelled':
    case 'team.run.cancelled':
      return event.payload.reason;
    case 'run.completed':
    case 'workflow.run.completed':
    case 'team.run.completed':
      return previewValue(event.payload.output);
    case 'model.started':
      return `step ${event.payload.step}`;
    case 'model.completed':
      return event.payload.usage ? previewValue(event.payload.usage) : `step ${event.payload.step}`;
    case 'context.compacted':
      return `${event.payload.removedMessages} mensajes · ${event.payload.estimatedTokens} → ${event.payload.compactedTokens} tokens`;
    case 'tool.started':
      return [
        event.payload.toolName,
        event.payload.source
          ? `${event.payload.source.connectionName}/${event.payload.source.remoteToolName}`
          : undefined,
        event.payload.risk ? `riesgo ${event.payload.risk}` : undefined,
      ].filter(Boolean).join(' · ');
    case 'tool.completed':
      return event.payload.toolName;
    case 'tool.failed':
      return `${event.payload.toolName}: ${event.payload.error}`;
    case 'tool.retrying':
      return `${event.payload.toolName}: ${event.payload.error}`;
    case 'tool.execution_unknown':
      return event.payload.toolName;
    case 'approval.requested':
      return `${event.payload.toolLabel ?? event.payload.toolName} · ${event.payload.approvalId}`;
    case 'approval.resolved':
      return `${event.payload.decision} · ${event.payload.actorId}`;
    case 'elicitation.requested':
      return event.payload.request.prompt;
    case 'elicitation.resolved':
      return event.payload.requestId;
    case 'policy.evaluated':
      return `${event.payload.policyName} · ${event.payload.decision} · ${event.payload.toolName}`;
    case 'artifact.created':
      return `${event.payload.descriptor.filename} · ${event.payload.descriptor.mimeType}`;
    case 'workflow.step.started':
      return [event.payload.stepId, event.payload.agentName].filter(Boolean).join(' · ');
    case 'workflow.step.completed':
      return event.payload.stepId;
    case 'workflow.step.failed':
      return `${event.payload.stepId}: ${event.payload.error}`;
    case 'workflow.wait.started':
      return [event.payload.stepId, event.payload.eventName ?? event.payload.resumeAt]
        .filter(Boolean)
        .join(' · ');
    case 'workflow.run.paused':
      return [event.payload.reason, event.payload.stepId].filter(Boolean).join(' · ');
    case 'team.agent.assigned':
      return `${event.payload.action} · ${event.payload.agentName}`;
    case 'team.handoff.created':
      return `${event.payload.from} → ${event.payload.to}: ${event.payload.reason}`;
    case 'team.task.completed':
      return event.payload.agentName;
    case 'team.task.failed':
      return `${event.payload.agentName ?? event.payload.delegationId}: ${event.payload.error}`;
    default:
      return undefined;
  }
}
