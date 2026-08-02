import {
  IntegrationError,
  SandboxError,
  type Sandbox,
  type SandboxRunResult,
} from '@fevex/core';
import type { ResolvedConfig } from '../config';

/**
 * Runs an `agent-browser` command through the run's sandbox and returns raw
 * stdout. Failures are normalized to `IntegrationError` with safe messages; the
 * underlying `SandboxError` is attached as `cause` and stderr is never echoed.
 */
export async function invoke(
  sandbox: Sandbox,
  args: readonly string[],
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<string> {
  let result: SandboxRunResult;
  try {
    result = await sandbox.run({
      command: config.binary,
      args,
      timeoutMs: config.timeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new IntegrationError('CONNECTION_TIMEOUT', 'timeout', true, 'Browser command was aborted', {
        cause: error,
      });
    }
    if (error instanceof SandboxError) {
      throw new IntegrationError('CONNECTION_REMOTE_ERROR', 'remote', false, 'Browser sandbox command failed', {
        cause: error,
      });
    }
    throw new IntegrationError('CONNECTION_REMOTE_ERROR', 'remote', false, 'Browser command failed', {
      cause: error,
    });
  }

  if (result.timedOut) {
    throw new IntegrationError('CONNECTION_TIMEOUT', 'timeout', true, 'Browser command timed out');
  }
  if (result.exitCode !== 0) {
    throw new IntegrationError(
      'CONNECTION_REMOTE_ERROR',
      'remote',
      false,
      'agent-browser exited with a non-zero status',
    );
  }
  return result.stdout;
}
