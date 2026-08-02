import type { ResolvedConfig } from '../config';

/**
 * DEFERRED — not registered by `createBrowserTools`.
 *
 * A screenshot must cross the Fevex boundary as an artifact reference
 * (`artifactId`, MIME, size, metadata) — never base64 or an internal path. That
 * requires the `@fevex/core/artifacts` contract, which does not exist yet.
 *
 * When artifacts land, this tool will:
 *   - run `agent-browser screenshot --json` to a per-run temp file inside the
 *     sandbox,
 *   - hand the bytes to an `ArtifactStore`,
 *   - return the resulting `ArtifactDescriptor` (risk: "read").
 *
 * See docs/fevex_integrations_roadmap.md — "Preview interno y artifacts".
 */
export function screenshotTool(_config: ResolvedConfig): never {
  throw new Error(
    'browser__screenshot is deferred until @fevex/core/artifacts exists; ' +
      'it is not registered by createBrowserTools.',
  );
}
