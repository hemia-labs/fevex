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
  const stdout = { text: '', bytes: 0 };
  const stderr = { text: '', bytes: 0 };

  return await new Promise((resolvePromise, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (killTimer !== undefined) return;
      child.kill('SIGTERM');
      // A cooperative stop is preferred, but ignoring SIGTERM must not outlive the limit.
      killTimer = setTimeout(() => child.kill('SIGKILL'), 100);
    };
    const abort = () => {
      aborted = true;
      clearTimeout(timer);
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      appendLimited(stdout, String(chunk), options.maxOutputBytes);
    });
    child.stderr.on('data', (chunk) => {
      appendLimited(stderr, String(chunk), options.maxOutputBytes);
    });
    child.on('error', (error) => {
      cleanup();
      reject(new SandboxError('SANDBOX_PROCESS_ERROR', 'Sandbox process failed', { cause: error }));
    });
    child.on('close', (exitCode) => {
      cleanup();
      if (aborted) {
        reject(options.signal?.reason ?? new DOMException('Sandbox aborted', 'AbortError'));
        return;
      }
      resolvePromise({
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function appendLimited(output: { text: string; bytes: number }, chunk: string, maxBytes: number): void {
  const remaining = maxBytes - output.bytes;
  if (remaining <= 0) return;
  const bytes = Buffer.from(chunk).subarray(0, remaining);
  output.bytes += bytes.length;
  // Streaming decode omits a character cut short by the byte limit.
  output.text += new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes, { stream: true });
}

function isInside(rootDir: string, value: string): boolean {
  const path = relative(rootDir, value);
  return path === '' || (!path.startsWith('..') && !resolve(path).startsWith('..'));
}
