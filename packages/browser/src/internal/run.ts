import { IntegrationError, type JsonValue, type ToolExecutionContext } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { invoke } from './invoke';
import { parseJson } from './parse';
import { assertBinaryVersion } from './version';

/** Verifies the binary, runs one command and parses its JSON output. */
export async function runBrowser(
  ctx: ToolExecutionContext,
  config: ResolvedConfig,
  args: readonly string[],
): Promise<JsonValue> {
  const sandbox = ctx.sandbox;
  if (!sandbox) {
    throw new IntegrationError(
      'CONNECTION_REMOTE_ERROR',
      'validation',
      false,
      'Browser tools require a sandbox on the Fevex config',
    );
  }
  await assertBinaryVersion(sandbox, config, ctx.signal);
  const stdout = await invoke(sandbox, args, config, ctx.signal);
  return parseJson(stdout, config.maxOutputChars);
}
