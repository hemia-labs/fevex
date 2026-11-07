import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SandboxRunRequest } from '@fevex/core';
import {
  createDockerSandbox,
  type DockerExecutor,
  type DockerExecutorInput,
  type DockerExecutorResult,
  type DockerSandbox,
  type DockerSandboxOptions,
} from './index';

interface Recorder {
  calls: DockerExecutorInput[];
  executor: DockerExecutor;
  queue(result: Partial<DockerExecutorResult>): void;
}

function recorder(): Recorder {
  const calls: DockerExecutorInput[] = [];
  const queued: DockerExecutorResult[] = [];
  const executor: DockerExecutor = async (input) => {
    calls.push(input);
    if (input.args[0] === 'run') return ok('container-id\n');
    if (input.args[0] === 'exec') return queued.shift() ?? ok('ok');
    return ok('');
  };
  return {
    calls,
    executor,
    queue(result) {
      queued.push({ ...ok(''), ...result });
    },
  };
}

function ok(stdout: string): DockerExecutorResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

function request(
  overrides: Partial<SandboxRunRequest> = {},
): SandboxRunRequest {
  return {
    command: 'sh',
    args: ['-c', 'echo ok'],
    capabilities: { process: { commands: ['sh'] } },
    ...overrides,
  };
}

function setup(overrides: Partial<DockerSandboxOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fevex-docker-sandbox-test-'));
  const rec = recorder();
  let sandbox: DockerSandbox;
  try {
    sandbox = createDockerSandbox({
      image: 'busybox:1.36',
      commands: ['sh'],
      workspaceRoot: root,
      executor: rec.executor,
      ...overrides,
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    rec,
    sandbox,
    async cleanup() {
      await sandbox.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('docker sandbox', () => {
  test('uses one isolated container per run and reuses it across calls', async () => {
    const { rec, sandbox, cleanup } = setup();
    try {
      await sandbox.run(request({ runId: 'run_1' }));
      await sandbox.run(request({ runId: 'run_1' }));
      await sandbox.run(request({ runId: 'run_2' }));

      const starts = rec.calls.filter((call) => call.args[0] === 'run');
      const execs = rec.calls.filter((call) => call.args[0] === 'exec');
      expect(starts).toHaveLength(2);
      expect(execs).toHaveLength(3);
      const volumes = starts.map((call) => call.args[call.args.indexOf('--volume') + 1]);
      expect(volumes[0]).not.toBe(volumes[1]);
      expect(volumes[0]).toContain(`${sandbox.workspaceFor('run_1')}:`);
    } finally {
      await cleanup();
    }
  });

  test('starts containers without network, capabilities or host environment', async () => {
    process.env.FEVEX_DOCKER_SANDBOX_LEAK = 'hidden';
    const { rec, sandbox, cleanup } = setup();
    try {
      await sandbox.run(request({ runId: 'run_1' }));
      const start = rec.calls.find((call) => call.args[0] === 'run')!;
      expect(start.args[start.args.indexOf('--network') + 1]).toBe('none');
      expect(start.args).toContain('--cap-drop');
      expect(start.args).toContain('ALL');
      expect(start.args).toContain('--read-only');
      expect(start.args).toContain('--pids-limit');
      expect(start.args).toContain('--security-opt');
      expect(start.args.join('\n')).not.toContain('FEVEX_DOCKER_SANDBOX_LEAK');
      expect(start.args.join('\n')).not.toContain('hidden');
    } finally {
      delete process.env.FEVEX_DOCKER_SANDBOX_LEAK;
      await cleanup();
    }
  });

  test('passes only explicit environment variables and stdin to exec', async () => {
    process.env.FEVEX_DOCKER_SANDBOX_LEAK = 'hidden';
    const { rec, sandbox, cleanup } = setup({ env: { BASE: 'one' } });
    try {
      await sandbox.run(
        request({
          runId: 'run_1',
          input: 'hello',
          env: { TOKEN: 'two' },
        }),
      );
      const exec = rec.calls.find((call) => call.args[0] === 'exec')!;
      expect(exec.args).toContain('BASE=one');
      expect(exec.args).toContain('TOKEN=two');
      expect(exec.args.join('\n')).not.toContain('FEVEX_DOCKER_SANDBOX_LEAK');
      expect(exec.input).toBe('hello');
    } finally {
      delete process.env.FEVEX_DOCKER_SANDBOX_LEAK;
      await cleanup();
    }
  });

  test('keeps provider security flags after user docker arguments', async () => {
    const { rec, sandbox, cleanup } = setup({
      dockerArgs: ['--network', 'bridge', '--cap-add', 'SYS_ADMIN'],
      memory: '256m',
      cpus: 0.5,
      user: '1000:1000',
      init: false,
    });
    try {
      await sandbox.run(request({ runId: 'run_1' }));
      const start = rec.calls.find((call) => call.args[0] === 'run')!;
      const networks = start.args
        .map((arg, index) => (arg === '--network' ? index : -1))
        .filter((index) => index >= 0);
      expect(start.args[networks.at(-1)! + 1]).toBe('none');
      expect(start.args).toContain('--cap-add');
      expect(start.args).toContain('--memory');
      expect(start.args).toContain('256m');
      expect(start.args).toContain('--cpus');
      expect(start.args).toContain('0.5');
      expect(start.args).toContain('--user');
      expect(start.args).toContain('1000:1000');
      expect(start.args).not.toContain('--init');
    } finally {
      await cleanup();
    }
  });

  test('denies commands outside the runtime and tool allowlists', async () => {
    const { sandbox, cleanup } = setup();
    try {
      await expect(
        sandbox.run(
          request({
            command: 'node',
            capabilities: { process: { commands: ['node'] } },
          }),
        ),
      ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_DENIED' });
      await expect(
        sandbox.run(
          request({
            command: 'sh',
            capabilities: { process: { commands: ['node'] } },
          }),
        ),
      ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_DENIED' });
      await expect(
        sandbox.run(request({ capabilities: undefined })),
      ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_DENIED' });
    } finally {
      await cleanup();
    }
  });

  test('keeps cwd inside the workspace', async () => {
    const { rec, sandbox, cleanup } = setup();
    try {
      await sandbox.run(request({ runId: 'run_1', cwd: 'work' }));
      const exec = rec.calls.find((call) => call.args[0] === 'exec')!;
      expect(exec.args[exec.args.indexOf('--workdir') + 1]).toBe('/workspace/work');

      for (const cwd of ['..', '../etc', '/etc', '/workspace/../etc']) {
        await expect(
          sandbox.run(request({ runId: 'run_1', cwd })),
        ).rejects.toMatchObject({ code: 'SANDBOX_CWD_DENIED' });
      }
    } finally {
      await cleanup();
    }
  });

  test('requires explicit bridge networking for network capabilities', async () => {
    const denied = setup();
    try {
      await expect(
        denied.sandbox.run(
          request({ capabilities: { process: { commands: ['sh'] }, network: { allow: ['example.com'] } } }),
        ),
      ).rejects.toMatchObject({ code: 'SANDBOX_NETWORK_UNSUPPORTED' });
    } finally {
      await denied.cleanup();
    }

    const allowed = setup({ network: 'bridge' });
    try {
      await allowed.sandbox.run(
        request({ capabilities: { process: { commands: ['sh'] }, network: { allow: ['example.com'] } } }),
      );
      const start = allowed.rec.calls.find((call) => call.args[0] === 'run')!;
      expect(start.args[start.args.indexOf('--network') + 1]).toBe('bridge');
    } finally {
      await allowed.cleanup();
    }
  });

  test('restarts the container after a timeout without losing the workspace', async () => {
    const { rec, sandbox, cleanup } = setup();
    try {
      rec.queue({
        exitCode: 137,
        stdout: 'partial',
        stderr: '',
        timedOut: true,
      });
      const first = await sandbox.run(request({ runId: 'run_1' }));
      expect(first).toMatchObject({ timedOut: true, stdout: 'partial' });
      const workspace = sandbox.workspaceFor('run_1')!;
      expect(existsSync(workspace)).toBe(true);

      await sandbox.run(request({ runId: 'run_1' }));
      expect(rec.calls.filter((call) => call.args[0] === 'run')).toHaveLength(2);
      expect(sandbox.workspaceFor('run_1')).toBe(workspace);
    } finally {
      await cleanup();
    }
  });

  test('retries once when the container disappeared', async () => {
    const { rec, sandbox, cleanup } = setup();
    try {
      rec.queue({ exitCode: 125, stderr: 'Error: No such container: fevex-sbx' });
      const result = await sandbox.run(request({ runId: 'run_1' }));
      expect(result.exitCode).toBe(0);
      expect(rec.calls.filter((call) => call.args[0] === 'run')).toHaveLength(2);
      expect(rec.calls.filter((call) => call.args[0] === 'exec')).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  test('cleans a run workspace and container on cleanupRun', async () => {
    const { rec, sandbox, cleanup } = setup();
    try {
      await sandbox.run(request({ runId: 'run_1' }));
      const workspace = sandbox.workspaceFor('run_1')!;
      expect(existsSync(workspace)).toBe(true);
      await sandbox.cleanupRun('run_1');
      expect(existsSync(workspace)).toBe(false);
      expect(sandbox.workspaceFor('run_1')).toBeUndefined();
      expect(rec.calls.some((call) => call.args[0] === 'rm')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('disposes every run and removes the provider root', async () => {
    const { rec, sandbox, cleanup } = setup();
    try {
      await sandbox.run(request({ runId: 'run_1' }));
      await sandbox.run(request({ runId: 'run_2' }));
      const workspace = sandbox.workspaceFor('run_1')!;
      const providerRoot = resolve(dirname(workspace), '..');
      await sandbox.dispose();
      expect(existsSync(providerRoot)).toBe(false);
      expect(rec.calls.filter((call) => call.args[0] === 'rm')).toHaveLength(2);
      await expect(sandbox.run(request({ runId: 'run_3' }))).rejects.toMatchObject({
        code: 'SANDBOX_DISPOSED',
      });
    } finally {
      await cleanup();
    }
  });

  test('cleans ephemeral calls that have no runId', async () => {
    const { sandbox, cleanup } = setup();
    try {
      await sandbox.run(request({ toolCallId: 'call_1' }));
      expect(sandbox.workspaceFor('call_1')).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test('validates configuration', () => {
    expect(() => setup({ image: '' })).toThrow('image');
    expect(() => setup({ commands: [] })).toThrow('commands');
    expect(() => setup({ commands: ['sh', 'sh'] })).toThrow('unique');
    expect(() => setup({ containerWorkdir: '/' })).toThrow('containerWorkdir');
    expect(() => setup({ network: 'host' as never })).toThrow('network');
    expect(() => setup({ defaultTimeoutMs: 0 })).toThrow('defaultTimeoutMs');
    expect(() => setup({ maxOutputBytes: 0 })).toThrow('maxOutputBytes');
    expect(() => setup({ pidsLimit: 0 })).toThrow('pidsLimit');
    expect(() => setup({ cpus: 0 })).toThrow('cpus');
    expect(() => setup({ env: { 'BAD-NAME': 'x' } })).toThrow('variable name');
    expect(() => setup({ keepAliveCommand: [] })).toThrow('keepAliveCommand');
    expect(() => setup({ executor: {} as never })).toThrow('executor');
  });
});
