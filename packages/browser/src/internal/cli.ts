import { IntegrationError } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { sessionArgs } from './session';

/**
 * Builds the argument array for an `agent-browser` command.
 *
 * Always an array — never a shell string — so nothing the model produces can be
 * interpreted by a shell. Global flags (`--json`, `--session`, security flags)
 * are appended centrally so every command is consistent.
 */
export function buildArgs(
  command: string,
  positional: readonly string[],
  config: ResolvedConfig,
  runId: string,
): string[] {
  const args: string[] = [command, ...positional, '--json', ...sessionArgs(runId)];
  if (config.contentBoundaries) args.push('--content-boundaries');
  if (config.idleTimeoutMs !== undefined) {
    args.push('--idle-timeout', String(config.idleTimeoutMs));
  }
  return args;
}

/** Appends `--allowed-domains` for navigation-style commands. */
export function withAllowedDomains(args: string[], config: ResolvedConfig): string[] {
  args.push('--allowed-domains', config.allowedDomains.join(','));
  return args;
}

/**
 * Local allowlist enforcement, applied before invoking the binary in addition to
 * the CLI `--allowed-domains` flag. Rejects out-of-scope hosts early.
 */
export function assertDomainAllowed(rawUrl: string, config: ResolvedConfig): void {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    throw new IntegrationError(
      'CONNECTION_TOOL_NOT_ALLOWED',
      'validation',
      false,
      'Navigation URL is not a valid absolute URL',
    );
  }
  if (!config.allowedDomains.some((pattern) => matchesDomain(host, pattern))) {
    throw new IntegrationError(
      'CONNECTION_TOOL_NOT_ALLOWED',
      'validation',
      false,
      'Navigation target is outside the allowed domains',
    );
  }
}

function matchesDomain(host: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(1); // ".example.com"
    return host === normalized.slice(2) || host.endsWith(suffix);
  }
  return host === normalized;
}
