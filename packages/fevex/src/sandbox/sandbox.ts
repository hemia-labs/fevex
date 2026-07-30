import type { ExecutionContext, JsonValue, RunId } from '../core';

export interface SandboxCapabilities {
  process?: {
    commands?: readonly string[];
    timeoutMs?: number;
  };
  filesystem?: {
    cwd?: string;
    read?: readonly string[];
    write?: readonly string[];
  };
  network?: false | {
    allow?: readonly string[];
  };
  resources?: {
    timeoutMs?: number;
    maxOutputBytes?: number;
  };
}

export interface SandboxRunRequest {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  capabilities?: SandboxCapabilities;
  runId?: RunId;
  toolCallId?: string;
  attempt?: number;
  idempotencyKey?: string;
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface SandboxRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface Sandbox {
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}

export class SandboxError extends Error {
  readonly name = 'SandboxError';

  constructor(
    readonly code: string,
    readonly safeMessage: string,
    options?: ErrorOptions,
  ) {
    super(safeMessage, options);
  }
}

export function sandboxResultToJson(result: SandboxRunResult): JsonValue {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };
}
