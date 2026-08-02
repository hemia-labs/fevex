import {
  IntegrationError,
  type JsonObject,
  type RunId,
  type Sandbox,
} from '@fevex/core';
import { resolveConfig, type ResolvedConfig } from './config';
import { buildArgs } from './internal/cli';
import { invoke } from './internal/invoke';
import { isRecord } from './internal/schema';
import { sessionName } from './internal/session';
import { assertBinaryVersion } from './internal/version';

export { sessionName } from './internal/session';

export interface PreviewFrame {
  mimeType: string;
  base64: string;
  capturedAt: string;
}

export interface BrowserPreviewOptions {
  /** Executable name resolved inside the sandbox. Default `agent-browser`. */
  binary?: string;
  /** Exact pinned `agent-browser` version; verified on first use. */
  expectedVersion: string;
  /** Sandbox network capability allowlist. Required and non-empty. */
  network: { allow: readonly string[] };
  /** Per-capture timeout in milliseconds. Default 30_000. */
  timeoutMs?: number;
  /** Max decoded frame size in bytes. Default 2_000_000. */
  maxFrameBytes?: number;
}

export interface CaptureInput {
  sandbox: Sandbox;
  runId: RunId;
  signal?: AbortSignal;
}

export interface BrowserPreview {
  capture(input: CaptureInput): Promise<PreviewFrame>;
}

const DEFAULT_MAX_FRAME_BYTES = 2_000_000;

/**
 * Host-side read-only preview of a run's browser session.
 *
 * Captures screenshots against the same `agent-browser` session the agent uses
 * (session affinity by `runId`). This is a host API — never a model tool — so
 * frames go host → viewer and never enter the run store or model history.
 */
export function createBrowserPreview(options: BrowserPreviewOptions): BrowserPreview {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createBrowserPreview requires an options object');
  }
  const maxFrameBytes = positiveInt(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 'maxFrameBytes');
  // The screenshot JSON wraps the base64 frame, so allow headroom above the frame cap.
  const config: ResolvedConfig = resolveConfig({
    ...(options.binary ? { binary: options.binary } : {}),
    expectedVersion: options.expectedVersion,
    // Preview never navigates; allowedDomains is required by resolveConfig but unused here.
    allowedDomains: options.network.allow,
    network: options.network,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    maxOutputBytes: maxFrameBytes + 65_536,
  });

  return {
    async capture({ sandbox, runId, signal }) {
      await assertBinaryVersion(sandbox, config, signal);
      const args = buildArgs('screenshot', [], config, runId);
      const stdout = await invoke(sandbox, args, config, signal);
      return parseFrame(stdout, maxFrameBytes);
    },
  };
}

function parseFrame(stdout: string, maxFrameBytes: number): PreviewFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw remoteError('agent-browser screenshot returned output that was not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw remoteError('agent-browser screenshot returned an unexpected shape');
  }
  const base64 = pickString(parsed, ['data', 'screenshot', 'base64']);
  if (!base64) {
    throw remoteError('agent-browser screenshot did not include image data');
  }
  const mimeType = pickString(parsed, ['mimeType', 'mime']) ?? formatToMime(pickString(parsed, ['format']));

  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > maxFrameBytes) {
    throw new IntegrationError(
      'BROWSER_FRAME_TOO_LARGE',
      'validation',
      false,
      'Preview frame exceeds the configured maxFrameBytes',
    );
  }
  return { mimeType, base64, capturedAt: new Date().toISOString() };
}

function pickString(record: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function formatToMime(format: string | undefined): string {
  switch ((format ?? 'png').toLowerCase()) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function remoteError(message: string): IntegrationError {
  return new IntegrationError('CONNECTION_REMOTE_ERROR', 'remote', false, message);
}

function positiveInt(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`createBrowserPreview "${field}" must be a positive integer`);
  }
  return value;
}
