import { createBrowserPreview, type PreviewFrame } from '@fevex/browser';
import type { RunId, Sandbox } from '@fevex/core';

/**
 * Source of read-only preview frames for a run's browser session.
 *
 * `mock` renders a synthetic SVG frame and works today without the
 * `agent-browser` binary or a network sandbox. `real` wraps `createBrowserPreview`
 * and needs a network-capable sandbox provider (not present in this example), so
 * it is provided for wiring completeness and will surface a clear error until one
 * exists.
 */
export interface PreviewFrameSource {
  capture(runId: RunId, signal?: AbortSignal): Promise<PreviewFrame>;
}

export function mockPreviewFrameSource(): PreviewFrameSource {
  let frame = 0;
  return {
    async capture(runId) {
      frame += 1;
      const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">`,
        `<rect width="100%" height="100%" fill="#0b1020"/>`,
        `<text x="24" y="48" fill="#7dd3fc" font-family="monospace" font-size="20">Fevex browser preview (mock)</text>`,
        `<text x="24" y="88" fill="#e2e8f0" font-family="monospace" font-size="16">run: ${escapeXml(String(runId))}</text>`,
        `<text x="24" y="120" fill="#e2e8f0" font-family="monospace" font-size="16">frame #${frame}</text>`,
        `<text x="24" y="152" fill="#94a3b8" font-family="monospace" font-size="14">${new Date().toISOString()}</text>`,
        `</svg>`,
      ].join('');
      return {
        mimeType: 'image/svg+xml',
        base64: Buffer.from(svg, 'utf8').toString('base64'),
        capturedAt: new Date().toISOString(),
      };
    },
  };
}

export function realPreviewFrameSource(input: {
  sandbox: Sandbox;
  expectedVersion: string;
  network: { allow: readonly string[] };
}): PreviewFrameSource {
  const preview = createBrowserPreview({
    expectedVersion: input.expectedVersion,
    network: input.network,
  });
  return {
    capture(runId, signal) {
      return preview.capture({ sandbox: input.sandbox, runId, ...(signal ? { signal } : {}) });
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
