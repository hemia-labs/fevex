import type { AgentEvent, JsonObject, JsonValue } from '../core';
import type { ModelMetadata, ModelUsage } from '../models';
import type {
  ObservabilityOptions,
  RunTrace,
  TraceAnnotation,
  TraceContent,
  TraceContentKind,
  TraceCost,
  TraceSpan,
  TraceStatus,
} from '../observability';
import type { AgentRun } from '../runtime';
import { toJsonValue } from './json';

const TERMINAL_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|credential|password|secret|token/i;

function durationMs(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function traceStatus(event: AgentEvent): TraceStatus {
  if (event.type === 'run.completed') return 'completed';
  if (event.type === 'run.cancelled') return 'cancelled';
  return 'failed';
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
    case 'tool.execution_unknown':
      return {
        name: event.type,
        timestamp: event.timestamp,
        attributes: {
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
        },
      };
    default:
      return undefined;
  }
}

interface OpenSpan {
  event: AgentEvent;
  annotations: TraceAnnotation[];
  output: string[];
}

export function buildRunTrace(
  run: AgentRun,
  rawEvents: readonly AgentEvent[],
  modelRegistryName: string,
  model: ModelMetadata | undefined,
  options: ObservabilityOptions,
): RunTrace {
  const events = [...rawEvents].sort((left, right) => left.sequence - right.sequence);
  const terminal = [...events].reverse().find((event) => TERMINAL_TYPES.has(event.type));
  if (!terminal) throw new TypeError(`Run "${run.id}" has no terminal event`);

  const started = events.find((event) => event.type === 'run.started') ?? events[0];
  if (!started) throw new TypeError(`Run "${run.id}" has no events`);

  const status = traceStatus(terminal);
  const annotations: TraceAnnotation[] = [];
  const spans: TraceSpan[] = [];
  const openModels = new Map<number, OpenSpan>();
  const openTools = new Map<string, OpenSpan>();
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
      parentId: run.id,
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
  const traceContent: TraceContent[] = [];
  if (terminal.type === 'run.completed') {
    const output = content(options, 'run.output', terminal.payload.output);
    if (output) traceContent.push(output);
  } else if (terminal.type === 'run.failed') {
    const error = content(options, 'error.message', terminal.payload.error);
    if (error) traceContent.push(error);
  }

  return {
    schemaVersion: '1',
    traceId: run.id,
    runId: run.id,
    sessionId: run.sessionId,
    agentName: run.agentName,
    modelRegistryName,
    ...(model ? { model: { ...model } } : {}),
    startedAt: started.timestamp,
    endedAt: terminal.timestamp,
    durationMs: durationMs(started.timestamp, terminal.timestamp),
    status,
    attributes: {
      eventCount: events.length,
      modelCallCount: spans.filter(({ kind }) => kind === 'model').length,
      toolCallCount: spans.filter(({ kind }) => kind === 'tool').length,
    },
    annotations,
    spans,
    ...(Object.keys(finalUsage).length ? { usage: { ...finalUsage } } : {}),
    ...(totalCost ? { cost: totalCost } : {}),
    ...(traceContent.length ? { content: traceContent } : {}),
  };
}
