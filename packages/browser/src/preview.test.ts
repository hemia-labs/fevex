import { describe, expect, test } from 'bun:test';
import { IntegrationError, type Sandbox, type SandboxRunRequest, type SandboxRunResult } from '@fevex/core';
import { createBrowserPreview, sessionName, type BrowserPreviewOptions } from './index';

const VERSION = '1.2.3';
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function baseOptions(overrides: Partial<BrowserPreviewOptions> = {}): BrowserPreviewOptions {
  return { expectedVersion: VERSION, network: { allow: ['docs.example.com'] }, ...overrides };
}

function ok(stdout: string): SandboxRunResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

function makeSandbox(handler: (req: SandboxRunRequest) => SandboxRunResult) {
  const requests: SandboxRunRequest[] = [];
  const sandbox: Sandbox = {
    async run(req) {
      requests.push(req);
      if (req.args?.includes('--version')) return ok(VERSION);
      return handler(req);
    },
  };
  return {
    sandbox,
    get commandRequests() {
      return requests.filter((r) => !r.args?.includes('--version'));
    },
  };
}

describe('createBrowserPreview', () => {
  test('captures a frame and parses base64 + mime', async () => {
    const rec = makeSandbox(() => ok(JSON.stringify({ data: PNG_1PX, mimeType: 'image/png' })));
    const preview = createBrowserPreview(baseOptions());
    const frame = await preview.capture({ sandbox: rec.sandbox, runId: 'run-1' });
    expect(frame.base64).toBe(PNG_1PX);
    expect(frame.mimeType).toBe('image/png');
    expect(Date.parse(frame.capturedAt)).not.toBeNaN();
  });

  test('runs screenshot --json against the run session', async () => {
    const rec = makeSandbox(() => ok(JSON.stringify({ screenshot: PNG_1PX, format: 'png' })));
    const preview = createBrowserPreview(baseOptions());
    await preview.capture({ sandbox: rec.sandbox, runId: 'run-42' });
    const args = rec.commandRequests[0]!.args!;
    expect(args).toContain('screenshot');
    expect(args).toContain('--json');
    const i = args.indexOf('--session');
    expect(args[i + 1]).toBe(sessionName('run-42'));
    expect(args[i + 1]).not.toContain('run-42');
  });

  test('derives mime from format when mimeType is absent', async () => {
    const rec = makeSandbox(() => ok(JSON.stringify({ data: PNG_1PX, format: 'jpeg' })));
    const preview = createBrowserPreview(baseOptions());
    const frame = await preview.capture({ sandbox: rec.sandbox, runId: 'run-1' });
    expect(frame.mimeType).toBe('image/jpeg');
  });

  test('rejects a frame larger than maxFrameBytes', async () => {
    const big = 'A'.repeat(4000); // ~3000 decoded bytes
    const rec = makeSandbox(() => ok(JSON.stringify({ data: big })));
    const preview = createBrowserPreview(baseOptions({ maxFrameBytes: 1000 }));
    await expect(
      preview.capture({ sandbox: rec.sandbox, runId: 'run-1' }),
    ).rejects.toMatchObject({ code: 'BROWSER_FRAME_TOO_LARGE', category: 'validation' });
  });

  test('non-image output becomes CONNECTION_REMOTE_ERROR', async () => {
    const rec = makeSandbox(() => ok(JSON.stringify({ status: 'ok' })));
    const preview = createBrowserPreview(baseOptions());
    await expect(
      preview.capture({ sandbox: rec.sandbox, runId: 'run-1' }),
    ).rejects.toMatchObject({ code: 'CONNECTION_REMOTE_ERROR' });
  });

  test('invalid JSON becomes CONNECTION_REMOTE_ERROR', async () => {
    const rec = makeSandbox(() => ok('not json'));
    const preview = createBrowserPreview(baseOptions());
    await expect(
      preview.capture({ sandbox: rec.sandbox, runId: 'run-1' }),
    ).rejects.toBeInstanceOf(IntegrationError);
  });

  test('version mismatch fails as BROWSER_VERSION_MISMATCH', async () => {
    const sandbox: Sandbox = {
      async run(req) {
        if (req.args?.includes('--version')) return ok('9.9.9');
        return ok(JSON.stringify({ data: PNG_1PX }));
      },
    };
    const preview = createBrowserPreview(baseOptions());
    await expect(
      preview.capture({ sandbox, runId: 'run-1' }),
    ).rejects.toMatchObject({ code: 'BROWSER_VERSION_MISMATCH' });
  });
});
