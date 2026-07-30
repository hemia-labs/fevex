import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
});
