import type { AgentEvent, JsonObject, JsonValue } from '../core';
import type { ModelMetadata, ModelUsage } from '../models';
import type {
  ObservabilityOptions,
  RunTrace,
  TraceAnnotation,
  TraceContent,
  TraceContentKind,
  TraceCost,
  TraceRunKind,
  TraceSpan,
  TraceStatus,
} from '../observability';
import type { AgentRun, CoordinatorRun, RunRecord } from '../runtime';
import { toJsonValue } from './json';
import { coordinatorName, isCoordinatorRun, isTeamRun } from './run-helpers';

const TERMINAL_TYPES = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'workflow.run.completed',
  'workflow.run.failed',
  'workflow.run.cancelled',
  'team.run.completed',
  'team.run.failed',
  'team.run.cancelled',
]);
const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|credential|password|secret|token/i;

export function isTraceTerminalEvent(event: AgentEvent): boolean {
  return TERMINAL_TYPES.has(event.type);
}

function durationMs(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function traceStatus(event: AgentEvent): TraceStatus {
  switch (event.type) {
    case 'run.completed':
    case 'workflow.run.completed':
    case 'team.run.completed':
      return 'completed';
    case 'run.cancelled':
    case 'workflow.run.cancelled':
    case 'team.run.cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

function redactKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactKeys);
  if (value === null || typeof value !== 'object') return value;

  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactKeys(item);
  }
  return result;
}

function content(
  options: ObservabilityOptions,
  kind: TraceContentKind,
  value: JsonValue,
): TraceContent | undefined {
  if (!options.content?.include.includes(kind)) return undefined;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as JsonValue;
    } catch {
      // Plain text remains plain text.
    }
  }
  const redacted = redactKeys(parsed);
  const safe = options.content.redact
    ? options.content.redact({ kind, value: redacted })
    : redacted;
  return safe === undefined
    ? undefined
    : {
        kind,
        value: toJsonValue(safe, `TraceRedactor output for "${kind}" must be JSON-serializable`),
      };
}

function usageFrom(value: JsonObject | undefined): ModelUsage | undefined {
  if (!value) return undefined;
  const usage: ModelUsage = {};
  if (typeof value.inputTokens === 'number') usage.inputTokens = value.inputTokens;
  if (typeof value.outputTokens === 'number') usage.outputTokens = value.outputTokens;
  if (typeof value.totalTokens === 'number') usage.totalTokens = value.totalTokens;
  return Object.keys(usage).length ? usage : undefined;
}

function subtractUsage(current: ModelUsage | undefined, previous: ModelUsage): ModelUsage | undefined {
  if (!current) return undefined;
  const usage: ModelUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (current[key] !== undefined) usage[key] = Math.max(0, current[key]! - (previous[key] ?? 0));
  }
  return Object.keys(usage).length ? usage : undefined;
}

function costFor(
  options: ObservabilityOptions,
  modelRegistryName: string,
  model: ModelMetadata | undefined,
  usage: ModelUsage | undefined,
): TraceCost | undefined {
  if (!options.calculateCost || !usage) return undefined;
  const cost = options.calculateCost({ modelRegistryName, model, usage });
  if (!cost) return undefined;
  if (!Number.isFinite(cost.amount) || cost.amount < 0 || !cost.currency.trim()) {
    throw new TypeError('CostCalculator must return a non-negative amount and currency');
  }
  return { amount: cost.amount, currency: cost.currency };
}

function annotation(event: AgentEvent): TraceAnnotation | undefined {
  switch (event.type) {
    case 'run.paused':
      return {
        name: event.type,
        timestamp: event.timestamp,
        attributes: {
          reason: event.payload.reason,
          toolCallId: event.payload.toolCallId,
        },
      };
    case 'run.resumed':
      return { name: event.type, timestamp: event.timestamp };
    case 'approval.requested':
      return {
        name: event.type,
        timestamp: event.timestamp,
        attributes: {
          approvalId: event.payload.approvalId,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
        },
      };
    case 'approval.resolved':
      return {
        name: event.type,
        timestamp: event.timestamp,
        attributes: {
          approvalId: event.payload.approvalId,
          toolCallId: event.payload.toolCallId,
          decision: event.payload.decision,
        },
      };
    case 'tool.retrying':
      return {
        name: event.type,
        timestamp: event.timestamp,
        attributes: {
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          attempt: event.payload.attempt,
          delayMs: event.payload.delayMs,
        },
      };
    case 'policy.evaluated':
      return {
        name: event.type,
        timestamp: event.timestamp,
        attributes: {
          policyName: event.payload.policyName,
          toolName: event.payload.toolName,
          ...(event.payload.toolCallId === undefined
            ? {}
            : { toolCallId: event.payload.toolCallId }),
          action: event.payload.action,
          decision: event.payload.decision,
          risk: event.payload.risk,
          ...(event.payload.declaredRisk === undefined
            ? {}
            : { declaredRisk: event.payload.declaredRisk }),
        },
      };
    case 'context.compacted':
      return {
        name: event.type,
        timestamp: event.timestamp,
        attributes: {
          removedMessages: event.payload.removedMessages,
          estimatedTokens: event.payload.estimatedTokens,
          compactedTokens: event.payload.compactedTokens,
          targetTokens: event.payload.targetTokens,
          contextWindow: event.payload.contextWindow,
        },
      };
    case 'tool.execution_unknown':
      return {
        name: event.type,
        timestamp: event.timestamp,
        attributes: {
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
        },
      };
    case 'workflow.run.paused':
    case 'team.run.paused': {
      const stepId = event.type === 'workflow.run.paused'
        ? event.payload.stepId
        : event.payload.delegationId;
      return {
        name: event.type,
        timestamp: event.timestamp,
        attributes: {
          stepId,
          reason: event.payload.reason,
          ...(event.payload.childRunId === undefined
            ? {}
            : { childRunId: event.payload.childRunId }),
        },
      };
    }
    case 'workflow.run.resumed':
    case 'team.run.resumed':
      return { name: event.type, timestamp: event.timestamp };
    case 'team.handoff.created':
      return {
        name: event.type,
        timestamp: event.timestamp,
        attributes: {
          delegationId: event.payload.delegationId,
          from: event.payload.from,
          to: event.payload.to,
          reason: event.payload.reason,
        },
      };
    default:
      return undefined;
  }
}

function terminalContent(
  options: ObservabilityOptions,
  terminal: AgentEvent,
): TraceContent[] {
  if (
    terminal.type === 'run.completed' ||
    terminal.type === 'workflow.run.completed' ||
    terminal.type === 'team.run.completed'
  ) {
    const output = content(options, 'run.output', terminal.payload.output);
    return output ? [output] : [];
  }
  if (
    terminal.type === 'run.failed' ||
    terminal.type === 'workflow.run.failed' ||
    terminal.type === 'team.run.failed'
  ) {
    const error = content(options, 'error.message', terminal.payload.error);
    return error ? [error] : [];
  }
  return [];
}

function sortedEvents(rawEvents: readonly AgentEvent[]): AgentEvent[] {
  return [...rawEvents].sort((left, right) => left.sequence - right.sequence);
}

function terminalEvent(runId: string, events: readonly AgentEvent[]): AgentEvent {
  const terminal = [...events].reverse().find((event) => isTraceTerminalEvent(event));
  if (!terminal) throw new TypeError(`Run "${runId}" has no terminal event`);
  return terminal;
}

function startEvent(events: readonly AgentEvent[]): AgentEvent {
  const started = events.find(
    (event) =>
      event.type === 'run.started' ||
      event.type === 'workflow.run.started' ||
      event.type === 'team.run.started',
  ) ?? events[0];
  if (!started) throw new TypeError('Run has no events');
  return started;
}

function traceKind(run: RunRecord): TraceRunKind {
  if (isTeamRun(run)) return 'team';
  return run.kind === 'workflow' ? 'workflow' : 'agent';
}

interface OpenSpan {
  event: AgentEvent;
  annotations: TraceAnnotation[];
  output: string[];
}

function buildAgentTrace(
  run: AgentRun,
  events: readonly AgentEvent[],
  modelRegistryName: string,
  model: ModelMetadata | undefined,
  options: ObservabilityOptions,
): RunTrace {
  const terminal = terminalEvent(run.id, events);
  const started = startEvent(events);
  const status = traceStatus(terminal);
  const annotations: TraceAnnotation[] = [];
  const spans: TraceSpan[] = [];
  const openModels = new Map<number, OpenSpan>();
  const openTools = new Map<string, OpenSpan>();
  const modelSpanByStep = new Map<number, string>();
  const previousUsage: ModelUsage = {};

  const closeModel = (step: number, endedAt: string, spanStatus: TraceStatus): void => {
    const open = openModels.get(step);
    if (!open) return;
    openModels.delete(step);
    const completed = events.find(
      (event) =>
        event.type === 'model.completed' &&
        event.payload.step === step &&
        event.sequence >= open.event.sequence,
    );
    const cumulative =
      completed?.type === 'model.completed' ? usageFrom(completed.payload.usage) : undefined;
    const usage = subtractUsage(cumulative, previousUsage);
    if (cumulative) Object.assign(previousUsage, cumulative);
    const spanContent = open.output.length
      ? content(options, 'model.output', open.output.join(''))
      : undefined;
    const span: TraceSpan = {
      id: open.event.id,
      parentId: run.id,
      kind: 'model',
      name: `model step ${step}`,
      startedAt: open.event.timestamp,
      endedAt,
      durationMs: durationMs(open.event.timestamp, endedAt),
      status: spanStatus,
      attributes: { step, modelRegistryName },
      annotations: open.annotations,
      ...(usage ? { usage } : {}),
      ...(spanContent ? { content: [spanContent] } : {}),
    };
    const spanCost = costFor(options, modelRegistryName, model, usage);
    if (spanCost) span.cost = spanCost;
    spans.push(span);
    modelSpanByStep.set(step, span.id);
  };

  const findOpenTool = (toolCallId: string): [string, OpenSpan] | undefined => {
    const entries = [...openTools.entries()];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      const value = entry[1];
      const event = value.event;
      if (event.type === 'tool.started' && event.payload.toolCallId === toolCallId) return entry;
    }
    return undefined;
  };

  const closeTool = (
    toolCallId: string,
    endedAt: string,
    spanStatus: TraceStatus,
    error?: string,
  ): void => {
    const entry = findOpenTool(toolCallId);
    if (!entry) return;
    const [key, open] = entry;
    openTools.delete(key);
    const event = open.event;
    if (event.type !== 'tool.started') return;
    const errorContent = error ? content(options, 'error.message', error) : undefined;
    spans.push({
      id: event.id,
      parentId: modelSpanByStep.get(event.payload.step) ?? run.id,
      kind: 'tool',
      name: event.payload.toolName,
      startedAt: event.timestamp,
      endedAt,
      durationMs: durationMs(event.timestamp, endedAt),
      status: spanStatus,
      attributes: {
        step: event.payload.step,
        toolCallId,
        toolName: event.payload.toolName,
        risk: event.payload.risk ?? 'read',
        ...(event.payload.declaredRisk === undefined
          ? {}
          : { declaredRisk: event.payload.declaredRisk }),
        attempt: event.payload.attempt ?? 1,
      },
      annotations: open.annotations,
      ...(errorContent ? { content: [errorContent] } : {}),
    });
  };

  for (const event of events) {
    const item = annotation(event);
    if (item) annotations.push(item);
    switch (event.type) {
      case 'model.started':
        openModels.set(event.payload.step, { event, annotations: [], output: [] });
        break;
      case 'model.output.delta':
        openModels.get(event.payload.step)?.output.push(event.payload.delta);
        break;
      case 'model.completed':
        closeModel(event.payload.step, event.timestamp, 'completed');
        break;
      case 'memory.completed': {
        const endedAt = Date.parse(event.timestamp);
        const startedAt = new Date(
          endedAt - Math.max(0, event.payload.durationMs),
        ).toISOString();
        const errorContent = event.payload.error
          ? content(options, 'error.message', event.payload.error)
          : undefined;
        spans.push({
          id: event.id,
          parentId: run.id,
          kind: 'memory',
          name: event.payload.operation === 'search' ? 'search_memory' : 'create_memory',
          startedAt,
          endedAt: event.timestamp,
          durationMs: Math.max(0, event.payload.durationMs),
          status: event.payload.error ? 'failed' : 'completed',
          attributes: {
            operation: event.payload.operation,
            ...(event.payload.recordCount === undefined
              ? {}
              : { recordCount: event.payload.recordCount }),
            ...(event.payload.recordId === undefined
              ? {}
              : { recordId: event.payload.recordId }),
          },
          annotations: [],
          ...(errorContent ? { content: [errorContent] } : {}),
        });
        break;
      }
      case 'tool.started': {
        const attempt = event.payload.attempt ?? 1;
        openTools.set(`${event.payload.toolCallId}:${attempt}`, {
          event,
          annotations: [],
          output: [],
        });
        break;
      }
      case 'tool.retrying': {
        const open = findOpenTool(event.payload.toolCallId)?.[1];
        const retry = annotation(event);
        if (open && retry) open.annotations.push(retry);
        closeTool(event.payload.toolCallId, event.timestamp, 'failed', event.payload.error);
        break;
      }
      case 'tool.completed':
        closeTool(event.payload.toolCallId, event.timestamp, 'completed');
        break;
      case 'tool.failed':
        closeTool(event.payload.toolCallId, event.timestamp, 'failed', event.payload.error);
        break;
      case 'tool.execution_unknown':
        closeTool(event.payload.toolCallId, event.timestamp, 'failed');
        break;
    }
  }

  for (const step of [...openModels.keys()]) closeModel(step, terminal.timestamp, status);
  for (const open of [...openTools.values()]) {
    if (open.event.type === 'tool.started') {
      closeTool(open.event.payload.toolCallId, terminal.timestamp, status);
    }
  }

  const finalUsage = run.usage ?? previousUsage;
  const totalCost = costFor(options, modelRegistryName, model, finalUsage);
  const traceContent = terminalContent(options, terminal);
  const startedAtMs = Math.min(
    Date.parse(started.timestamp),
    ...spans
      .filter(({ kind }) => kind === 'memory')
      .map(({ startedAt }) => Date.parse(startedAt)),
  );
  const traceStartedAt = new Date(startedAtMs).toISOString();

  return {
    schemaVersion: '1',
    kind: 'agent',
    traceId: run.id,
    runId: run.id,
    sessionId: run.sessionId,
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    rootRunId: run.rootRunId ?? run.parentRunId ?? run.id,
    agentName: run.agentName,
    modelRegistryName,
    ...(model ? { model: { ...model } } : {}),
    startedAt: traceStartedAt,
    endedAt: terminal.timestamp,
    durationMs: durationMs(traceStartedAt, terminal.timestamp),
    status,
    attributes: {
      eventCount: events.length,
      modelCallCount: spans.filter(({ kind }) => kind === 'model').length,
      toolCallCount: spans.filter(({ kind }) => kind === 'tool').length,
      memoryOperationCount: spans.filter(({ kind }) => kind === 'memory').length,
    },
    annotations,
    spans,
    ...(Object.keys(finalUsage).length ? { usage: { ...finalUsage } } : {}),
    ...(totalCost ? { cost: totalCost } : {}),
    ...(traceContent.length ? { content: traceContent } : {}),
  };
}

interface OpenStep {
  event: AgentEvent;
  name: string;
  attributes: JsonObject;
}

function buildCoordinatorTrace(
  run: CoordinatorRun,
  events: readonly AgentEvent[],
  options: ObservabilityOptions,
): RunTrace {
  const terminal = terminalEvent(run.id, events);
  const started = startEvent(events);
  const status = traceStatus(terminal);
  const annotations: TraceAnnotation[] = [];
  const spans: TraceSpan[] = [];
  const openSteps = new Map<string, OpenStep>();
  const stepKey = (scope: 'workflow' | 'team', stepId: string): string => `${scope}:${stepId}`;
  const modelCallCount = events.filter(({ type }) => type === 'model.completed').length;
  const toolCallCount = events.filter(
    ({ type }) => type === 'tool.completed' || type === 'tool.failed',
  ).length;

  const openStep = (
    key: string,
    event: AgentEvent,
    name: string,
    attributes: JsonObject,
  ): void => {
    openSteps.set(key, { event, name, attributes });
  };

  const closeStep = (
    key: string,
    endedAt: string,
    spanStatus: TraceStatus,
    error?: string,
  ): void => {
    const open = openSteps.get(key);
    if (!open) return;
    openSteps.delete(key);
    const errorContent = error ? content(options, 'error.message', error) : undefined;
    spans.push({
      id: open.event.id,
      parentId: run.id,
      kind: 'step',
      name: open.name,
      startedAt: open.event.timestamp,
      endedAt,
      durationMs: durationMs(open.event.timestamp, endedAt),
      status: spanStatus,
      attributes: open.attributes,
      annotations: [],
      ...(errorContent ? { content: [errorContent] } : {}),
    });
  };

  for (const event of events) {
    const item = annotation(event);
    if (item) annotations.push(item);
    switch (event.type) {
      case 'workflow.step.started':
        openStep(stepKey('workflow', event.payload.stepId), event, event.payload.stepId, {
          stepId: event.payload.stepId,
          stepKind: event.payload.kind,
          ...(event.payload.agentName === undefined
            ? {}
            : { agentName: event.payload.agentName }),
          ...(event.payload.childRunId === undefined
            ? {}
            : { childRunId: event.payload.childRunId }),
        });
        break;
      case 'workflow.step.completed':
        closeStep(stepKey('workflow', event.payload.stepId), event.timestamp, 'completed');
        break;
      case 'workflow.step.failed':
        closeStep(
          stepKey('workflow', event.payload.stepId),
          event.timestamp,
          'failed',
          event.payload.error,
        );
        break;
      case 'workflow.wait.started':
        openStep(stepKey('workflow', event.payload.stepId), event, event.payload.stepId, {
          stepId: event.payload.stepId,
          stepKind: 'wait',
          waitKind: event.payload.kind,
          ...(event.payload.resumeAt === undefined ? {} : { resumeAt: event.payload.resumeAt }),
          ...(event.payload.eventName === undefined ? {} : { eventName: event.payload.eventName }),
        });
        break;
      case 'workflow.wait.completed':
        closeStep(stepKey('workflow', event.payload.stepId), event.timestamp, 'completed');
        break;
      case 'team.agent.assigned':
        openStep(stepKey('team', event.payload.delegationId), event, event.payload.delegationId, {
          stepId: event.payload.delegationId,
          stepKind: 'agent',
          agentName: event.payload.agentName,
          action: event.payload.action,
          ...(event.payload.expectedOutput === undefined
            ? {}
            : { expectedOutput: event.payload.expectedOutput }),
          ...(event.payload.constraints === undefined
            ? {}
            : { constraints: event.payload.constraints }),
          ...(event.payload.childRunId === undefined
            ? {}
            : { childRunId: event.payload.childRunId }),
        });
        break;
      case 'team.task.completed':
        closeStep(stepKey('team', event.payload.delegationId), event.timestamp, 'completed');
        break;
      case 'team.task.failed':
        closeStep(
          stepKey('team', event.payload.delegationId),
          event.timestamp,
          'failed',
          event.payload.error,
        );
        break;
      case 'team.merge.started':
        openStep(stepKey('team', event.payload.stepId), event, event.payload.stepId, {
          stepId: event.payload.stepId,
          stepKind: 'merge',
          width: event.payload.width,
        });
        break;
      case 'team.merge.completed':
        closeStep(stepKey('team', event.payload.stepId), event.timestamp, 'completed');
        break;
      case 'team.merge.failed':
        closeStep(
          stepKey('team', event.payload.stepId),
          event.timestamp,
          'failed',
          event.payload.error,
        );
        break;
    }
  }

  for (const key of [...openSteps.keys()]) closeStep(key, terminal.timestamp, status);

  const traceContent = terminalContent(options, terminal);
  return {
    schemaVersion: '1',
    kind: traceKind(run),
    traceId: run.id,
    runId: run.id,
    sessionId: run.sessionId,
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    rootRunId: run.rootRunId ?? run.parentRunId ?? run.id,
    agentName: coordinatorName(run),
    startedAt: started.timestamp,
    endedAt: terminal.timestamp,
    durationMs: durationMs(started.timestamp, terminal.timestamp),
    status,
    attributes: {
      eventCount: events.length,
      stepCount: spans.filter(({ kind }) => kind === 'step').length,
      modelCallCount,
      toolCallCount,
    },
    annotations,
    spans,
    ...(run.usage && Object.keys(run.usage).length ? { usage: { ...run.usage } } : {}),
    ...(traceContent.length ? { content: traceContent } : {}),
  };
}

export function buildRunTrace(
  run: RunRecord,
  rawEvents: readonly AgentEvent[],
  modelRegistryName: string | undefined,
  model: ModelMetadata | undefined,
  options: ObservabilityOptions,
): RunTrace {
  const events = sortedEvents(rawEvents);
  if (isCoordinatorRun(run)) return buildCoordinatorTrace(run, events, options);
  if (!modelRegistryName) {
    throw new TypeError(`Run "${run.id}" has no model registry name`);
  }
  return buildAgentTrace(run as AgentRun, events, modelRegistryName, model, options);
}
