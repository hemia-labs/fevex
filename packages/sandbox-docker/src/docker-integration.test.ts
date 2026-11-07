import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxRunRequest } from '@fevex/core';
import { createDockerSandbox, type DockerSandboxOptions } from './index';

setDefaultTimeout(30_000);

const dockerPath = Bun.which('docker');
const image = process.env.FEVEX_DOCKER_TEST_IMAGE ?? 'busybox:1.36';
const available = dockerPath !== null
  && spawnSync(dockerPath, ['info'], { stdio: 'ignore' }).status === 0
  && spawnSync(dockerPath, ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
const dockerTest = available ? test : test.skip;

function request(
  runId: string,
  script: string,
  overrides: Partial<SandboxRunRequest> = {},
): SandboxRunRequest {
  return {
    command: 'sh',
    args: ['-c', script],
    capabilities: { process: { commands: ['sh'] } },
    runId,
    ...overrides,
  };
}

function setup(overrides: Partial<DockerSandboxOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fevex-docker-integration-'));
  const sandbox = createDockerSandbox({
    image,
    commands: ['sh'],
    workspaceRoot: root,
    dockerPath: dockerPath ?? 'docker',
    defaultTimeoutMs: 15_000,
    ...overrides,
  });
  return {
    sandbox,
    root,
    async cleanup() {
      await sandbox.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('docker sandbox integration', () => {
  dockerTest('isolates filesystems between concurrent runs', async () => {
    const { sandbox, cleanup } = setup();
    try {
      const [left, right] = await Promise.all([
        sandbox.run(request('run_left', 'echo left > /workspace/value; cat /workspace/value')),
        sandbox.run(request('run_right', 'echo right > /workspace/value; cat /workspace/value')),
      ]);
      expect(left.stdout.trim()).toBe('left');
      expect(right.stdout.trim()).toBe('right');
      expect((await sandbox.run(request('run_left', 'cat /workspace/value'))).stdout.trim())
        .toBe('left');
      expect((await sandbox.run(request('run_right', 'cat /workspace/value'))).stdout.trim())
        .toBe('right');
    } finally {
      await cleanup();
    }
  });

  dockerTest('keeps files across calls in the same run', async () => {
    const { sandbox, cleanup } = setup();
    try {
      const written = await sandbox.run(
        request('run_persist', 'printf hello > /workspace/file'),
      );
      expect(written.exitCode).toBe(0);
      const result = await sandbox.run(request('run_persist', 'cat /workspace/file'));
      expect(result.stdout).toBe('hello');
    } finally {
      await cleanup();
    }
  });

  dockerTest('does not inherit host credentials or environment', async () => {
    process.env.FEVEX_DOCKER_TEST_SECRET = 'top-secret';
    const { sandbox, cleanup } = setup();
    try {
      const result = await sandbox.run(
        request('run_env', 'printf %s "${FEVEX_DOCKER_TEST_SECRET:-empty}"'),
      );
      expect(result.stdout).toBe('empty');
    } finally {
      delete process.env.FEVEX_DOCKER_TEST_SECRET;
      await cleanup();
    }
  });

  dockerTest('times out, kills the container and restarts it on the next call', async () => {
    const { sandbox, cleanup } = setup();
    try {
      const started = Date.now();
      const timedOut = await sandbox.run(
        request('run_timeout', 'trap "" TERM; sleep 30', { timeoutMs: 300 }),
      );
      expect(timedOut.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);

      const after = await sandbox.run(request('run_timeout', 'printf after'));
      expect(after.stdout).toBe('after');
      expect(after.timedOut).toBe(false);
    } finally {
      await cleanup();
    }
  });

  dockerTest('bounds multibyte output without splitting characters', async () => {
    const { sandbox, cleanup } = setup();
    try {
      const result = await sandbox.run(
        request('run_bytes', "printf '界😀'", { maxOutputBytes: 4 }),
      );
      expect(result.stdout).toBe('界');
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4);
    } finally {
      await cleanup();
    }
  });

  dockerTest('cleans the run workspace and container', async () => {
    const { sandbox, cleanup } = setup();
    try {
      await sandbox.run(request('run_cleanup', 'printf data > /workspace/file'));
      const workspace = sandbox.workspaceFor('run_cleanup')!;
      expect(existsSync(workspace)).toBe(true);
      await sandbox.cleanupRun('run_cleanup');
      expect(existsSync(workspace)).toBe(false);
      expect(sandbox.workspaceFor('run_cleanup')).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
