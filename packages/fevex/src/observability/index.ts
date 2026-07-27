import type { JsonObject, JsonValue, RunId } from '../core';
import type { ModelMetadata, ModelUsage } from '../models';
import type { SessionId } from '../runtime';

export type TraceStatus = 'completed' | 'failed' | 'cancelled';
export type TraceSpanKind = 'model' | 'tool';
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
  traceId: string;
  runId: RunId;
  sessionId: SessionId;
  agentName: string;
  modelRegistryName: string;
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

export interface ObservabilityOptions {
  exporters: readonly TraceExporter[];
  calculateCost?: CostCalculator;
  content?: TraceContentPolicy;
}
