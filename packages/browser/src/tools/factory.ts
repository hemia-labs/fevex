import { defineTool, type JsonValue, type ToolDefinition, type ToolRisk } from '@fevex/core';
import type { ResolvedConfig } from '../config';
import { buildArgs } from '../internal/cli';
import { runBrowser } from '../internal/run';
import type { BrowserSchema } from '../internal/schema';
import { jsonObjectOutput } from '../internal/schema';

export interface BrowserToolSpec<TInput> {
  name: string;
  description: string;
  risk: Extract<ToolRisk, 'read' | 'write'>;
  /** Force approval regardless of policy (defaults follow risk). */
  approval?: 'required';
  inputSchema: BrowserSchema<TInput>;
  /** Base command and positional args for agent-browser. */
  command: string;
  positional: (input: TInput, config: ResolvedConfig) => string[];
  /** Extra flags appended after the shared globals (e.g. --allowed-domains). */
  extraArgs?: (input: TInput, config: ResolvedConfig) => string[];
  /** Local validation/guards run before invoking the binary. */
  guard?: (input: TInput, config: ResolvedConfig) => void;
}

/** Builds a curated browser tool with the shared execute pipeline. */
export function createBrowserTool<TInput>(
  spec: BrowserToolSpec<TInput>,
  config: ResolvedConfig,
): ToolDefinition {
  return defineTool({
    name: spec.name,
    description: spec.description,
    risk: spec.risk,
    ...(spec.approval ? { approval: spec.approval } : {}),
    inputSchema: spec.inputSchema,
    outputSchema: jsonObjectOutput,
    sandbox: config.sandbox,
    async execute(input: TInput, ctx): Promise<JsonValue> {
      spec.guard?.(input, config);
      const args = buildArgs(spec.command, spec.positional(input, config), config, ctx.runId);
      if (spec.extraArgs) args.push(...spec.extraArgs(input, config));
      return runBrowser(ctx, config, args);
    },
  });
}
