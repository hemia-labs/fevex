import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalSandbox, SandboxError } from './index';

const command = process.execPath;

describe('local sandbox', () => {
  test('executes allowlisted commands with an empty environment by default', async () => {
    process.env.FEVEX_SANDBOX_SECRET = 'hidden';
    const sandbox = createLocalSandbox({ rootDir: process.cwd(), commands: [command] });

    const result = await sandbox.run({
      command,
      args: ['-e', 'console.log(process.env.FEVEX_SANDBOX_SECRET ?? "empty")'],
      capabilities: { process: { commands: [command] } },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('empty');
    delete process.env.FEVEX_SANDBOX_SECRET;
  });

  test('rejects commands outside the runtime and tool allowlists', async () => {
    const sandbox = createLocalSandbox({ rootDir: process.cwd(), commands: [command] });

    await expect(
      sandbox.run({
        command: 'node',
        capabilities: { process: { commands: ['node'] } },
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_DENIED' });
    await expect(
      sandbox.run({
        command,
        capabilities: { process: { commands: ['node'] } },
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_DENIED' });
  });

  test('keeps cwd inside rootDir', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fevex-sandbox-'));
    try {
      const sandbox = createLocalSandbox({ rootDir: directory, commands: [command] });
      const result = await sandbox.run({
        command,
        args: ['-e', 'console.log(process.cwd())'],
        capabilities: { process: { commands: [command] } },
      });
      expect(result.stdout.trim()).toBe(realpathSync(directory));
      await expect(
        sandbox.run({
          command,
          cwd: '..',
          capabilities: { process: { commands: [command] } },
        }),
      ).rejects.toMatchObject({ code: 'SANDBOX_CWD_DENIED' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('times out and limits output bytes', async () => {
    const sandbox = createLocalSandbox({
      rootDir: process.cwd(),
      commands: [command],
      defaultTimeoutMs: 10,
      maxOutputBytes: 4,
    });
    const timedOut = await sandbox.run({
      command,
      args: ['-e', 'setTimeout(() => {}, 1000)'],
      capabilities: { process: { commands: [command] } },
    });
    expect(timedOut).toMatchObject({ timedOut: true });

    const limited = await sandbox.run({
      command,
      args: ['-e', 'console.log("abcdef")'],
      capabilities: { process: { commands: [command] } },
    });
    expect(limited.stdout.length).toBeLessThanOrEqual(4);
  });

  test('rejects explicit network access locally', async () => {
    const sandbox = createLocalSandbox({ rootDir: process.cwd(), commands: [command] });

    await expect(
      sandbox.run({
        command,
        capabilities: {
          process: { commands: [command] },
          network: { allow: ['example.com'] },
        },
      }),
    ).rejects.toBeInstanceOf(SandboxError);
  });

  test('forces termination when a timed-out process ignores SIGTERM', async () => {
    const sandbox = createLocalSandbox({ rootDir: process.cwd(), commands: [command] });
    const result = await sandbox.run({
      command,
      args: ['-e', `
        process.on('SIGTERM', () => {});
        process.stdout.write('ready');
        setTimeout(() => { process.stdout.write('natural-exit'); process.exit(0); }, 2000);
      `],
      capabilities: { process: { commands: [command] } },
      timeoutMs: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('ready');
    expect(result.exitCode).not.toBe(0);
  });

  test('kills an aborted process before rejecting with the original reason', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fevex-sandbox-abort-'));
    const ready = join(directory, 'ready');
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    let pid: number | undefined;
    let running: Promise<unknown> | undefined;
    try {
      const sandbox = createLocalSandbox({ rootDir: directory, commands: [command] });
      running = sandbox.run({
        command,
        args: ['-e', `
          process.on('SIGTERM', () => {});
          require('node:fs').writeFileSync('ready', String(process.pid));
          setTimeout(() => process.exit(0), 2000);
        `],
        capabilities: { process: { commands: [command] } },
        signal: controller.signal,
      });
      for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(ready)).toBe(true);
      pid = Number(readFileSync(ready, 'utf8'));
      controller.abort(reason);
      await expect(running).rejects.toBe(reason);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      controller.abort(reason);
      if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      await running?.catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keeps the truncated prefix when Unicode output arrives in separate chunks', async () => {
    const sandbox = createLocalSandbox({ rootDir: process.cwd(), commands: [command] });
    const result = await sandbox.run({
      command,
      args: ['-e', `
        process.stdout.write('界'); process.stderr.write('界');
        setTimeout(() => { process.stdout.write('a'); process.stderr.write('a'); }, 50);
      `],
      capabilities: { process: { commands: [command] } },
      maxOutputBytes: 1,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  for (const [text, maxOutputBytes, expected] of [
    ['界😀', 1, ''],
    ['界😀', 8, '界😀'],
    ['\uFEFF界😀', 8, '\uFEFF界'],
  ] as const) {
    test(`bounds ${JSON.stringify(text)} stdout and stderr to ${maxOutputBytes} bytes without splitting characters`, async () => {
      const sandbox = createLocalSandbox({ rootDir: process.cwd(), commands: [command] });
      const result = await sandbox.run({
        command,
        args: ['-e', `process.stdout.write(${JSON.stringify(text.repeat(10))}); process.stderr.write(${JSON.stringify(text.repeat(10))})`],
        capabilities: { process: { commands: [command] } },
        maxOutputBytes,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(expected);
      expect(result.stderr).toBe(result.stdout);
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(maxOutputBytes);
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(maxOutputBytes);
    });
  }
});
