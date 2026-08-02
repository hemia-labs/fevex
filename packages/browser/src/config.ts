import type { SandboxCapabilities } from '@fevex/core';

export interface BrowserToolsOptions {
  /** Executable name resolved inside the sandbox. Default `agent-browser`. */
  binary?: string;
  /** Exact `agent-browser` version pinned to the sandbox image; verified on first use. */
  expectedVersion: string;
  /** Domains the agent may navigate to. Required and non-empty. */
  allowedDomains: readonly string[];
  /** Sandbox network capability allowlist. Required and non-empty. */
  network: { allow: readonly string[] };
  /** Mark web content as untrusted via `--content-boundaries`. Default true. */
  contentBoundaries?: boolean;
  /** Fevex-side cap on characters returned to the run. Default 50_000. */
  maxOutputChars?: number;
  /** Sandbox-side cap on process output bytes. Default 200_000. */
  maxOutputBytes?: number;
  /** Per tool-call timeout in milliseconds. Default 30_000. */
  timeoutMs?: number;
  /** Idle timeout for abandoned sessions, passed as `--idle-timeout`. */
  idleTimeoutMs?: number;
}

export interface ResolvedConfig {
  binary: string;
  expectedVersion: string;
  allowedDomains: readonly string[];
  network: { allow: readonly string[] };
  contentBoundaries: boolean;
  maxOutputChars: number;
  maxOutputBytes: number;
  timeoutMs: number;
  idleTimeoutMs?: number;
  sandbox: SandboxCapabilities;
}

const DEFAULTS = {
  binary: 'agent-browser',
  contentBoundaries: true,
  maxOutputChars: 50_000,
  maxOutputBytes: 200_000,
  timeoutMs: 30_000,
} as const;

/** Validates options at factory time and freezes the shared sandbox capability. */
export function resolveConfig(options: BrowserToolsOptions): ResolvedConfig {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createBrowserTools requires an options object');
  }
  if (typeof options.expectedVersion !== 'string' || !options.expectedVersion.trim()) {
    throw new TypeError('createBrowserTools requires a non-empty "expectedVersion"');
  }
  const allowedDomains = dedupeNonEmpty(options.allowedDomains, 'allowedDomains');
  const networkAllow = dedupeNonEmpty(options.network?.allow, 'network.allow');

  const binary = options.binary?.trim() || DEFAULTS.binary;
  const maxOutputChars = positiveInt(options.maxOutputChars, DEFAULTS.maxOutputChars, 'maxOutputChars');
  const maxOutputBytes = positiveInt(options.maxOutputBytes, DEFAULTS.maxOutputBytes, 'maxOutputBytes');
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs');
  const idleTimeoutMs =
    options.idleTimeoutMs === undefined
      ? undefined
      : positiveInt(options.idleTimeoutMs, DEFAULTS.timeoutMs, 'idleTimeoutMs');

  const sandbox: SandboxCapabilities = {
    process: { commands: [binary] },
    network: { allow: networkAllow },
    resources: { timeoutMs, maxOutputBytes },
  };

  return {
    binary,
    expectedVersion: options.expectedVersion,
    allowedDomains,
    network: { allow: networkAllow },
    contentBoundaries: options.contentBoundaries ?? DEFAULTS.contentBoundaries,
    maxOutputChars,
    maxOutputBytes,
    timeoutMs,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    sandbox,
  };
}

function dedupeNonEmpty(values: readonly string[] | undefined, field: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`createBrowserTools requires a non-empty "${field}"`);
  }
  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (cleaned.length === 0) {
    throw new TypeError(`createBrowserTools "${field}" must contain non-empty entries`);
  }
  return Object.freeze([...new Set(cleaned)]);
}

function positiveInt(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`createBrowserTools "${field}" must be a positive integer`);
  }
  return value;
}
