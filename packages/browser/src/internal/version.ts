import { IntegrationError, type Sandbox } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { invoke } from './invoke';

/**
 * Verifies the pinned `agent-browser` version once per factory config.
 *
 * agent-browser requires Node 24 and is installed into the sandbox image, not
 * shipped as a dependency of `@fevex/browser`. Checking the exact version on
 * first use makes an incompatible binary fail early instead of mid-run.
 */
const verified = new WeakMap<ResolvedConfig, Promise<void>>();

export function assertBinaryVersion(
  sandbox: Sandbox,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<void> {
  let pending = verified.get(config);
  if (!pending) {
    pending = checkVersion(sandbox, config, signal).catch((error) => {
      verified.delete(config); // allow a later run to retry the check
      throw error;
    });
    verified.set(config, pending);
  }
  return pending;
}

async function checkVersion(
  sandbox: Sandbox,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<void> {
  const stdout = await invoke(sandbox, ['--version'], config, signal);
  if (!stdout.includes(config.expectedVersion)) {
    throw new IntegrationError(
      'BROWSER_VERSION_MISMATCH',
      'validation',
      false,
      `agent-browser version does not match the pinned "${config.expectedVersion}"`,
    );
  }
}
