import type { ToolDefinition } from '@fevex/core';
import { resolveConfig, type BrowserToolsOptions } from './config';
import { navigateTool } from './tools/navigate';
import { snapshotTool } from './tools/snapshot';
import { readTool } from './tools/read';
import { getTool } from './tools/get';
import { clickTool } from './tools/click';
import { fillTool } from './tools/fill';
import { waitTool } from './tools/wait';
import { tabsTool } from './tools/tabs';
import { closeTool } from './tools/close';

export {
  createBrowserPreview,
  sessionName,
  type BrowserPreview,
  type BrowserPreviewOptions,
  type CaptureInput,
  type PreviewFrame,
} from './preview';
export type { BrowserToolsOptions } from './config';
export type { NavigateInput } from './tools/navigate';
export type { SnapshotInput } from './tools/snapshot';
export type { ReadInput } from './tools/read';
export type { GetInput } from './tools/get';
export type { ClickInput } from './tools/click';
export type { FillInput } from './tools/fill';
export type { WaitInput } from './tools/wait';
export type { TabsInput } from './tools/tabs';
export type { CloseInput } from './tools/close';

/**
 * Creates the curated `browser__*` tool set backed by `agent-browser`.
 *
 * Every tool runs the pinned binary inside `context.sandbox`, keyed to the run
 * for session affinity, with a network allowlist baked in at factory time.
 * `browser__screenshot` is intentionally omitted until `@fevex/core/artifacts`
 * exists.
 */
export function createBrowserTools(options: BrowserToolsOptions): ToolDefinition[] {
  const config = resolveConfig(options);
  return [
    navigateTool(config),
    snapshotTool(config),
    readTool(config),
    getTool(config),
    clickTool(config),
    fillTool(config),
    waitTool(config),
    tabsTool(config),
    closeTool(config),
  ];
}
