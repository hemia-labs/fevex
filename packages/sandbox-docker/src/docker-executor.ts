import { spawn } from 'node:child_process';
import { SandboxError } from '@fevex/core';

export interface DockerExecutorInput {
  dockerPath: string;
  containerName: string;
  args: readonly string[];
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface DockerExecutorResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Runs one Docker CLI invocation. Injectable so tests do not need a daemon. */
export type DockerExecutor = (
  input: DockerExecutorInput,
) => Promise<DockerExecutorResult>;

/** Default executor backed by the `docker` CLI. */
export function createDockerExecutor(): DockerExecutor {
  return async (input) => {
    const started = Date.now();
    let timedOut = false;
    let aborted = false;
    const stdout = { text: '', bytes: 0 };
    const stderr = { text: '', bytes: 0 };

    return await new Promise<DockerExecutorResult>((resolvePromise, reject) => {
      input.signal?.throwIfAborted();

      const child = spawn(input.dockerPath, [...input.args], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        input.signal?.removeEventListener('abort', abort);
      };
      const terminate = () => {
        if (killTimer !== undefined) return;
        // Kill the container first so an exec that ignores signals cannot survive.
        const killer = spawn(input.dockerPath, ['kill', input.containerName], {
          shell: false,
          stdio: 'ignore',
        });
        killer.on('error', () => {});
        child.kill('SIGTERM');
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
      }, input.timeoutMs);

      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        appendLimited(stdout, String(chunk), input.maxOutputBytes);
      });
      child.stderr.on('data', (chunk) => {
        appendLimited(stderr, String(chunk), input.maxOutputBytes);
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new SandboxError('SANDBOX_PROCESS_ERROR', 'Docker CLI failed', { cause: error }),
        );
      });
      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (aborted) {
          reject(
            input.signal?.reason
              ?? new DOMException('Sandbox aborted', 'AbortError'),
          );
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

      if (input.input !== undefined) child.stdin.end(input.input);
      else child.stdin.end();
    });
  };
}

function appendLimited(
  output: { text: string; bytes: number },
  chunk: string,
  maxBytes: number,
): void {
  const remaining = maxBytes - output.bytes;
  if (remaining <= 0) return;
  const bytes = Buffer.from(chunk).subarray(0, remaining);
  output.bytes += bytes.length;
  // Streaming decode omits a character cut short by the byte limit.
  output.text += new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes, {
    stream: true,
  });
}
