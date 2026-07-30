import type { ExecutionContext, JsonObject, JsonValue, RunId, ToolEventSource } from '../core';
import type { ToolApproval, ToolIdempotency, ToolRetryPolicy, ToolRisk } from './tool';

export interface ToolProviderContext {
  runId?: RunId;
  toolCallId?: string;
  attempt?: number;
  idempotencyKey?: string;
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface ToolProviderTool {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
}

export interface ToolProvider {
  kind?: string;
  listTools(context?: ToolProviderContext): Promise<ToolProviderTool[]>;
  callTool(
    name: string,
    input: JsonValue,
    context: ToolProviderContext,
  ): JsonValue | Promise<JsonValue>;
  close?(): Promise<void>;
}

export type IntegrationErrorCategory = 'auth' | 'validation' | 'network' | 'remote' | 'timeout';

/** Safe, provider-neutral error surfaced by connection adapters. */
export class IntegrationError extends Error {
  readonly name = 'IntegrationError';

  constructor(
    readonly code: string,
    readonly category: IntegrationErrorCategory,
    readonly retryable: boolean,
    readonly safeMessage: string,
    options?: ErrorOptions & { source?: ToolEventSource },
  ) {
    super(safeMessage, options);
    this.source = options?.source;
  }

  readonly source?: ToolEventSource;
}

export interface ConnectionToolPolicy {
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  risk?: ToolRisk;
  approval?: ToolApproval;
  idempotency?: ToolIdempotency;
  retry?: ToolRetryPolicy;
  credentials?: string[];
}

export interface ConnectionDefinition {
  name: string;
  provider: ToolProvider;
  allowlist?: readonly string[];
  tools?: { allow: readonly string[] } | Record<string, ConnectionToolPolicy>;
  timeoutMs?: number;
}

export function defineConnection<TDefinition extends ConnectionDefinition>(
  connection: TDefinition,
): TDefinition {
  return connection;
}
