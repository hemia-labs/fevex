import type { JsonObject, JsonValue, RunId } from '../core';
import type { ModelMetadata, ModelUsage } from '../models';
import type { SessionId } from '../runtime';

/** Final state represented by an exported run trace. */
export type TraceStatus = 'completed' | 'failed' | 'cancelled';
/** Kind of run that produced a trace. Absent means `agent` for older traces. */
export type TraceRunKind = 'agent' | 'workflow' | 'team';
/** Model, tool and memory operations are agent spans; steps belong to coordinator traces. */
export type TraceSpanKind = 'model' | 'tool' | 'memory' | 'step';
export type TraceContentKind = 'run.output' | 'model.output' | 'error.message';

export interface TraceCost {
  amount: number;
  currency: string;
}

export interface TraceContent {
  kind: TraceContentKind;
  value: JsonValue;
}

export interface TraceAnnotation {
  name: string;
  timestamp: string;
  attributes?: JsonObject;
}

export interface TraceSpan {
  id: string;
  /** Run or span that contains this span. */
  parentId: string;
  kind: TraceSpanKind;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: TraceStatus;
  attributes: JsonObject;
  annotations: TraceAnnotation[];
  usage?: ModelUsage;
  cost?: TraceCost;
  content?: TraceContent[];
}

export interface RunTrace {
  schemaVersion: '1';
  /** Absent on traces produced before coordinator traces existed; treat as `agent`. */
  kind?: TraceRunKind;
  traceId: string;
  runId: RunId;
  sessionId: SessionId;
  /** Agent, workflow or team name. */
  agentName: string;
  /** Run that created this one, when it belongs to a workflow or team. */
  parentRunId?: RunId;
  /** Top-level run in the correlation tree. Defaults to `runId`. */
  rootRunId?: RunId;
  /** Only present on agent traces. */
  modelRegistryName?: string;
  model?: ModelMetadata;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: TraceStatus;
  attributes: JsonObject;
  annotations: TraceAnnotation[];
  spans: TraceSpan[];
  usage?: ModelUsage;
  cost?: TraceCost;
  content?: TraceContent[];
}

export interface CostCalculatorInput {
  modelRegistryName: string;
  model?: ModelMetadata;
  usage: ModelUsage;
}

export type CostCalculator = (input: CostCalculatorInput) => TraceCost | undefined;

export interface TraceRedactorInput {
  kind: TraceContentKind;
  value: JsonValue;
}

export type TraceRedactor = (input: TraceRedactorInput) => JsonValue | undefined;

export interface TraceContentPolicy {
  include: readonly TraceContentKind[];
  redact?: TraceRedactor;
}

export interface TraceExporter {
  export(trace: Readonly<RunTrace>): void | Promise<void>;
}

export interface TraceExportQueueOptions {
  /** Traces exported at once. Defaults to 4. */
  concurrency?: number;
  /** Traces waiting for an export slot before new traces are dropped. Defaults to 100. */
  maxQueued?: number;
  /** Deadline for each exporter call. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Failures retained for the next `flushObservability` call. Defaults to 100. */
  maxFailures?: number;
}

/** Queue and failure counters for the runtime's trace exporters. */
export interface ObservabilityStats {
  /** Traces exported successfully since the runtime started. */
  exported: number;
  /** Failed exports and dropped traces since the runtime started. */
  failed: number;
  /** Traces dropped because the queue was full. */
  dropped: number;
  /** Traces waiting for an export slot. */
  queued: number;
  /** Traces currently being exported. */
  active: number;
  /** Failures retained for the next flush. */
  retainedFailures: number;
}

export interface ObservabilityOptions {
  exporters: readonly TraceExporter[];
  calculateCost?: CostCalculator;
  content?: TraceContentPolicy;
  exportQueue?: TraceExportQueueOptions;
}
