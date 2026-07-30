import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  SandboxError,
  type Sandbox,
  type SandboxRunResult,
} from './sandbox';

export interface LocalSandboxOptions {
  rootDir: string;
  commands: readonly string[];
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

/** Creates a subprocess sandbox restricted to a root directory and command allowlist. */
export function createLocalSandbox(options: LocalSandboxOptions): Sandbox {
  if (!options.rootDir.trim()) {
    throw new SandboxError('SANDBOX_INVALID_CONFIG', 'Sandbox rootDir must be non-empty');
  }
  if (!options.commands.length || options.commands.some((command) => !command.trim())) {
    throw new SandboxError(
      'SANDBOX_INVALID_CONFIG',
      'Sandbox commands allowlist must contain non-empty commands',
    );
  }
  const rootDir = realpathSync(resolve(options.rootDir));
  const allowed = new Set(options.commands);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64_000;

  return {
    async run(request) {
      if (request.capabilities?.network) {
        throw new SandboxError(
          'SANDBOX_NETWORK_UNSUPPORTED',
          'Local sandbox does not support network access',
        );
      }
      const command = request.command;
      if (!allowed.has(command) || !request.capabilities?.process?.commands?.includes(command)) {
        throw new SandboxError('SANDBOX_COMMAND_DENIED', `Command "${command}" is not allowed`);
      }
      const cwd = resolve(rootDir, request.cwd ?? request.capabilities.filesystem?.cwd ?? '.');
      if (!isInside(rootDir, cwd)) {
        throw new SandboxError('SANDBOX_CWD_DENIED', 'Sandbox cwd must stay inside rootDir');
      }
      const timeoutMs =
        request.timeoutMs ??
        request.capabilities.resources?.timeoutMs ??
        request.capabilities.process.timeoutMs ??
        defaultTimeoutMs;
      const outputLimit = request.maxOutputBytes ??
        request.capabilities.resources?.maxOutputBytes ??
        maxOutputBytes;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw new SandboxError('SANDBOX_INVALID_REQUEST', 'Sandbox timeoutMs must be positive');
      }
      if (!Number.isInteger(outputLimit) || outputLimit < 1) {
        throw new SandboxError('SANDBOX_INVALID_REQUEST', 'Sandbox maxOutputBytes must be positive');
      }

      return runProcess({
        command,
        args: request.args ?? [],
        cwd,
        env: { ...(options.env ?? {}), ...(request.env ?? {}) },
        input: request.input,
        timeoutMs,
        maxOutputBytes: outputLimit,
        signal: request.signal,
      });
    },
  };
}

async function runProcess(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}): Promise<SandboxRunResult> {
  const started = Date.now();
  let timedOut = false;
  let stdout = '';
  let stderr = '';

  return await new Promise((resolvePromise, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const abort = () => {
      child.kill('SIGTERM');
      reject(options.signal?.reason ?? new DOMException('Sandbox aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, String(chunk), options.maxOutputBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, String(chunk), options.maxOutputBytes);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(new SandboxError('SANDBOX_PROCESS_ERROR', 'Sandbox process failed', { cause: error }));
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolvePromise({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function appendLimited(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  return Buffer.byteLength(next) <= maxBytes ? next : next.slice(0, maxBytes);
}

function isInside(rootDir: string, value: string): boolean {
  const path = relative(rootDir, value);
  return path === '' || (!path.startsWith('..') && !resolve(path).startsWith('..'));
}
