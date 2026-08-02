import { describe, expect, test } from 'bun:test';
import { IntegrationError, type Sandbox, type SandboxRunRequest, type SandboxRunResult, type ToolDefinition, type ToolExecutionContext } from '@fevex/core';
import { createBrowserTools, type BrowserToolsOptions } from './index';

const VERSION = '1.2.3';

function baseOptions(overrides: Partial<BrowserToolsOptions> = {}): BrowserToolsOptions {
  return {
    expectedVersion: VERSION,
    allowedDomains: ['docs.example.com', '*.cdn.example.com'],
    network: { allow: ['docs.example.com'] },
    ...overrides,
  };
}

interface Recorder {
  sandbox: Sandbox;
  requests: SandboxRunRequest[];
  commandRequests: SandboxRunRequest[];
}

/** Fake sandbox: answers `--version` with the pinned version, else `handler`. */
function makeSandbox(handler: (req: SandboxRunRequest) => SandboxRunResult): Recorder {
  const requests: SandboxRunRequest[] = [];
  const sandbox: Sandbox = {
    async run(req) {
      requests.push(req);
      if (req.args?.includes('--version')) {
        return ok(VERSION);
      }
      return handler(req);
    },
  };
  return {
    sandbox,
    requests,
    get commandRequests() {
      return requests.filter((r) => !r.args?.includes('--version'));
    },
  };
}

function ok(stdout: string): SandboxRunResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

function ctx(sandbox: Sandbox, runId = 'run-1', signal?: AbortSignal): ToolExecutionContext {
  return {
    runId,
    toolCallId: 'call-1',
    attempt: 1,
    idempotencyKey: 'key-1',
    getCredential: async () => {
      throw new Error('no credentials in browser tools');
    },
    sandbox,
    ...(signal ? { signal } : {}),
  };
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe('createBrowserTools', () => {
  test('registers the 9 MVP tools and omits screenshot', () => {
    const names = createBrowserTools(baseOptions()).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'browser__click',
        'browser__close',
        'browser__fill',
        'browser__get',
        'browser__navigate',
        'browser__read',
        'browser__snapshot',
        'browser__tabs',
        'browser__wait',
      ].sort(),
    );
    expect(names).not.toContain('browser__screenshot');
  });

  test('bakes the sandbox network allowlist into every tool', () => {
    const tools = createBrowserTools(baseOptions());
    for (const t of tools) {
      expect(t.sandbox?.network).toEqual({ allow: ['docs.example.com'] });
      expect(t.sandbox?.process?.commands).toEqual(['agent-browser']);
    }
  });

  test('marks read vs write risk and forces approval on click/fill', () => {
    const tools = createBrowserTools(baseOptions());
    expect(tool(tools, 'browser__navigate').risk).toBe('read');
    expect(tool(tools, 'browser__snapshot').risk).toBe('read');
    expect(tool(tools, 'browser__click').risk).toBe('write');
    expect(tool(tools, 'browser__click').approval).toBe('required');
    expect(tool(tools, 'browser__fill').approval).toBe('required');
  });
});

describe('option validation', () => {
  test('rejects empty allowedDomains', () => {
    expect(() => createBrowserTools(baseOptions({ allowedDomains: [] }))).toThrow(/allowedDomains/);
  });
  test('rejects empty network allow', () => {
    expect(() => createBrowserTools(baseOptions({ network: { allow: [] } }))).toThrow(/network.allow/);
  });
  test('rejects missing expectedVersion', () => {
    expect(() =>
      createBrowserTools(baseOptions({ expectedVersion: '' })),
    ).toThrow(/expectedVersion/);
  });
});

describe('navigate', () => {
  test('parses golden JSON output', async () => {
    const rec = makeSandbox(() => ok(JSON.stringify({ url: 'https://docs.example.com/', ok: true })));
    const tools = createBrowserTools(baseOptions());
    const result = await tool(tools, 'browser__navigate').execute(
      { url: 'https://docs.example.com/' },
      ctx(rec.sandbox),
    );
    expect(result).toEqual({ url: 'https://docs.example.com/', ok: true });
  });

  test('builds args with --json, --session and --allowed-domains, never a shell string', async () => {
    const rec = makeSandbox(() => ok('{}'));
    const tools = createBrowserTools(baseOptions());
    await tool(tools, 'browser__navigate').execute(
      { url: 'https://docs.example.com/guide' },
      ctx(rec.sandbox),
    );
    const req = rec.commandRequests[0]!;
    expect(req.command).toBe('agent-browser');
    expect(Array.isArray(req.args)).toBe(true);
    expect(req.args).toContain('--json');
    expect(req.args).toContain('--content-boundaries');
    expect(req.args).toContain('navigate');
    expect(req.args).toContain('https://docs.example.com/guide');
    const domainsIndex = req.args!.indexOf('--allowed-domains');
    expect(domainsIndex).toBeGreaterThan(-1);
    expect(req.args![domainsIndex + 1]).toBe('docs.example.com,*.cdn.example.com');
  });

  test('accepts wildcard subdomains from the allowlist', async () => {
    const rec = makeSandbox(() => ok('{}'));
    const tools = createBrowserTools(baseOptions());
    await tool(tools, 'browser__navigate').execute(
      { url: 'https://assets.cdn.example.com/app.js' },
      ctx(rec.sandbox),
    );
    expect(rec.commandRequests).toHaveLength(1);
  });

  test('rejects an out-of-scope domain before invoking the binary', async () => {
    const rec = makeSandbox(() => ok('{}'));
    const tools = createBrowserTools(baseOptions());
    await expect(
      tool(tools, 'browser__navigate').execute({ url: 'https://evil.example.net/' }, ctx(rec.sandbox)),
    ).rejects.toMatchObject({ code: 'CONNECTION_TOOL_NOT_ALLOWED', category: 'validation' });
    expect(rec.requests).toHaveLength(0); // never touched the sandbox
  });

  test('rejects a non-URL input', async () => {
    const rec = makeSandbox(() => ok('{}'));
    const tools = createBrowserTools(baseOptions());
    await expect(
      tool(tools, 'browser__navigate').execute({ url: 'not a url' }, ctx(rec.sandbox)),
    ).rejects.toMatchObject({ code: 'CONNECTION_TOOL_NOT_ALLOWED' });
  });
});

describe('session affinity', () => {
  test('same run reuses one session; different runs differ', async () => {
    const rec = makeSandbox(() => ok('{}'));
    const tools = createBrowserTools(baseOptions());
    const nav = tool(tools, 'browser__navigate');
    await nav.execute({ url: 'https://docs.example.com/a' }, ctx(rec.sandbox, 'run-A'));
    await nav.execute({ url: 'https://docs.example.com/b' }, ctx(rec.sandbox, 'run-A'));
    await nav.execute({ url: 'https://docs.example.com/c' }, ctx(rec.sandbox, 'run-B'));

    const sessions = rec.commandRequests.map((r) => {
      const i = r.args!.indexOf('--session');
      return r.args![i + 1];
    });
    expect(sessions[0]).toBe(sessions[1]!);
    expect(sessions[0]).not.toBe(sessions[2]!);
    expect(sessions[0]).toMatch(/^fevex-[0-9a-f]{24}$/);
    // no raw run id leaks into the session name
    expect(sessions[0]).not.toContain('run-A');
  });
});

describe('failure normalization', () => {
  test('timed-out command becomes CONNECTION_TIMEOUT', async () => {
    const rec = makeSandbox(() => ({ exitCode: null, stdout: '', stderr: '', durationMs: 5, timedOut: true }));
    const tools = createBrowserTools(baseOptions());
    await expect(
      tool(tools, 'browser__snapshot').execute({}, ctx(rec.sandbox)),
    ).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT', category: 'timeout', retryable: true });
  });

  test('non-zero exit becomes CONNECTION_REMOTE_ERROR without leaking stderr', async () => {
    const secret = 'Cookie: session=supersecret';
    const rec = makeSandbox(() => ({ exitCode: 1, stdout: '', stderr: secret, durationMs: 5, timedOut: false }));
    const tools = createBrowserTools(baseOptions());
    try {
      await tool(tools, 'browser__snapshot').execute({}, ctx(rec.sandbox));
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationError);
      const err = error as IntegrationError;
      expect(err.code).toBe('CONNECTION_REMOTE_ERROR');
      expect(err.safeMessage).not.toContain('supersecret');
      expect(err.message).not.toContain('supersecret');
    }
  });

  test('invalid JSON becomes CONNECTION_REMOTE_ERROR', async () => {
    const rec = makeSandbox(() => ok('<html>not json</html>'));
    const tools = createBrowserTools(baseOptions());
    await expect(
      tool(tools, 'browser__read').execute({}, ctx(rec.sandbox)),
    ).rejects.toMatchObject({ code: 'CONNECTION_REMOTE_ERROR' });
  });

  test('aborted signal becomes CONNECTION_TIMEOUT', async () => {
    const controller = new AbortController();
    controller.abort();
    const rec = makeSandbox(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const tools = createBrowserTools(baseOptions());
    await expect(
      tool(tools, 'browser__snapshot').execute({}, ctx(rec.sandbox, 'run-1', controller.signal)),
    ).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
  });
});

describe('output limits', () => {
  test('truncates long string fields to maxOutputChars', async () => {
    const long = 'x'.repeat(500);
    const rec = makeSandbox(() => ok(JSON.stringify({ text: long })));
    const tools = createBrowserTools(baseOptions({ maxOutputChars: 100 }));
    const result = (await tool(tools, 'browser__read').execute({}, ctx(rec.sandbox))) as {
      text: string;
    };
    expect(result.text.startsWith('x'.repeat(100))).toBe(true);
    expect(result.text).toContain('truncated');
    expect(result.text.length).toBeLessThan(long.length);
  });
});

describe('version pinning', () => {
  test('mismatched binary version fails as BROWSER_VERSION_MISMATCH', async () => {
    const rec: SandboxRunRequest[] = [];
    const sandbox: Sandbox = {
      async run(req) {
        rec.push(req);
        if (req.args?.includes('--version')) return ok('9.9.9');
        return ok('{}');
      },
    };
    const tools = createBrowserTools(baseOptions());
    await expect(
      tool(tools, 'browser__snapshot').execute({}, ctx(sandbox)),
    ).rejects.toMatchObject({ code: 'BROWSER_VERSION_MISMATCH', category: 'validation' });
  });

  test('version is checked once per config across calls', async () => {
    let versionChecks = 0;
    const sandbox: Sandbox = {
      async run(req) {
        if (req.args?.includes('--version')) {
          versionChecks += 1;
          return ok(VERSION);
        }
        return ok('{}');
      },
    };
    const tools = createBrowserTools(baseOptions());
    const snap = tool(tools, 'browser__snapshot');
    await snap.execute({}, ctx(sandbox));
    await snap.execute({}, ctx(sandbox));
    expect(versionChecks).toBe(1);
  });
});
