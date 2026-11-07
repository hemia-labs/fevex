import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import {
  SandboxError,
  type RunId,
  type Sandbox,
  type SandboxRunRequest,
  type SandboxRunResult,
} from '@fevex/core';
import {
  createDockerExecutor,
  type DockerExecutor,
  type DockerExecutorResult,
} from './docker-executor';

const DEFAULT_CONTAINER_WORKDIR = '/workspace';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64_000;
const DEFAULT_PIDS_LIMIT = 128;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_KEEP_ALIVE = ['tail', '-f', '/dev/null'] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DockerSandboxOptions {
  /** Image used for every run. Pull it before starting the runtime. */
  image: string;
  /** Commands the runtime allows. A tool must also declare the command. */
  commands: readonly string[];
  /**
   * Host directory that contains provider workspaces. Defaults to a private
   * temporary directory. Each provider instance creates its own subtree.
   */
  workspaceRoot?: string;
  /** Docker CLI executable. Defaults to `docker`. */
  dockerPath?: string;
  /** Absolute workdir inside the container. Defaults to `/workspace`. */
  containerWorkdir?: string;
  /** Container network mode. Defaults to `none`. */
  network?: 'none' | 'bridge';
  /** Default command timeout. Defaults to 10 seconds. */
  defaultTimeoutMs?: number;
  /** Default stdout/stderr byte cap. Defaults to 64 KiB each. */
  maxOutputBytes?: number;
  /** Time allowed for `docker run -d`. Defaults to 15 seconds. */
  startupTimeoutMs?: number;
  /** Extra environment variables passed to every exec. */
  env?: Record<string, string>;
  /** Docker memory limit, for example `512m`. */
  memory?: string;
  /** Docker CPU limit, for example `1.5`. */
  cpus?: number;
  /** Docker PID limit. Defaults to 128. */
  pidsLimit?: number;
  /** User inside the container. Defaults to the image user. */
  user?: string;
  /** Run the container with Docker's init process. Defaults to true. */
  init?: boolean;
  /** Keep-alive command used to hold the container open. */
  keepAliveCommand?: readonly string[];
  /** Keep workspaces after cleanup for inspection or artifact promotion. */
  keepWorkspaces?: boolean;
  /** Extra `docker run` arguments, for example read-only input mounts. */
  dockerArgs?: readonly string[];
  /** Injectable Docker CLI runner. Defaults to the local `docker` binary. */
  executor?: DockerExecutor;
}

export interface DockerSandbox extends Sandbox {
  cleanupRun(runId: RunId): Promise<void>;
  dispose(): Promise<void>;
  /** Host workspace for an active run. */
  workspaceFor(runId: RunId): string | undefined;
}

interface RunState {
  key: string;
  workspace: string;
  containerName: string;
  containerId?: string;
  ephemeral: boolean;
}

/**
 * Docker-backed sandbox for production runs.
 *
 * Each run gets a bind-mounted workspace and a long-lived container so tools
 * can keep filesystem, processes and sockets across calls. Containers drop
 * capabilities, use a read-only root with a private `/tmp`, and have no network
 * unless `network: 'bridge'` is explicitly configured.
 */
export function createDockerSandbox(options: DockerSandboxOptions): DockerSandbox {
  if (!isRecord(options)) {
    throw invalidConfig('Docker sandbox options must be an object');
  }
  const image = nonEmpty(options.image, 'image');
  const commands = normalizeCommands(options.commands);
  const allowed = new Set(commands);
  const dockerPath = nonEmpty(options.dockerPath ?? 'docker', 'dockerPath');
  const containerWorkdir = normalizeContainerWorkdir(
    options.containerWorkdir ?? DEFAULT_CONTAINER_WORKDIR,
  );
  const network = options.network ?? 'none';
  if (network !== 'none' && network !== 'bridge') {
    throw invalidConfig('Docker sandbox network must be "none" or "bridge"');
  }
  const defaultTimeoutMs = positiveInteger(
    options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    'defaultTimeoutMs',
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    'maxOutputBytes',
  );
  const startupTimeoutMs = positiveInteger(
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    'startupTimeoutMs',
  );
  const pidsLimit = positiveInteger(options.pidsLimit ?? DEFAULT_PIDS_LIMIT, 'pidsLimit');
  const env = normalizeEnv(options.env, 'Docker sandbox env');
  const keepAlive = normalizeArgs(
    options.keepAliveCommand ?? DEFAULT_KEEP_ALIVE,
    'keepAliveCommand',
    { allowEmpty: false },
  );
  const extraDockerArgs = normalizeArgs(options.dockerArgs ?? [], 'dockerArgs');
  if (options.memory !== undefined) nonEmpty(options.memory, 'memory');
  if (
    options.cpus !== undefined
    && (typeof options.cpus !== 'number' || !Number.isFinite(options.cpus) || options.cpus <= 0)
  ) {
    throw invalidConfig('Docker sandbox cpus must be a positive number');
  }
  if (options.user !== undefined) nonEmpty(options.user, 'user');
  if (options.init !== undefined && typeof options.init !== 'boolean') {
    throw invalidConfig('Docker sandbox init must be a boolean');
  }
  if (options.keepWorkspaces !== undefined && typeof options.keepWorkspaces !== 'boolean') {
    throw invalidConfig('Docker sandbox keepWorkspaces must be a boolean');
  }
  const executor = options.executor ?? createDockerExecutor();
  if (typeof executor !== 'function') {
    throw invalidConfig('Docker sandbox executor must be a function');
  }

  const providerRoot = createProviderRoot(options.workspaceRoot);
  const keepWorkspaces = options.keepWorkspaces ?? false;
  const runs = new Map<string, RunState>();
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) {
      throw new SandboxError('SANDBOX_DISPOSED', 'Docker sandbox has been disposed');
    }
  };

  const startContainer = async (
    state: RunState,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const args = [
      'run',
      '-d',
      '--rm',
      '--name',
      state.containerName,
      ...extraDockerArgs,
      '--label',
      'fevex.sandbox=true',
      '--label',
      `fevex.sandbox.key=${hashKey(state.key)}`,
      '--network',
      network,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(pidsLimit),
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--volume',
      `${state.workspace}:${containerWorkdir}`,
      '--workdir',
      containerWorkdir,
      ...(options.init === false ? [] : ['--init']),
      ...(options.memory === undefined ? [] : ['--memory', options.memory]),
      ...(options.cpus === undefined ? [] : ['--cpus', String(options.cpus)]),
      ...(options.user === undefined ? [] : ['--user', options.user]),
      image,
      ...keepAlive,
    ];
    const result = await executor({
      dockerPath,
      containerName: state.containerName,
      args,
      timeoutMs: startupTimeoutMs,
      maxOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.timedOut) {
      throw new SandboxError(
        'SANDBOX_START_FAILED',
        `Docker sandbox timed out starting image "${image}"`,
      );
    }
    if (result.exitCode !== 0) {
      throw new SandboxError(
        'SANDBOX_START_FAILED',
        `Docker sandbox failed to start image "${image}"`,
        { cause: new Error(limitMessage(result.stderr)) },
      );
    }
    const containerId = result.stdout.trim().split('\n').at(-1)?.trim();
    if (!containerId) {
      throw new SandboxError(
        'SANDBOX_START_FAILED',
        `Docker sandbox did not return a container id for image "${image}"`,
      );
    }
    state.containerId = containerId;
  };

  const ensureContainer = async (
    state: RunState,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    if (state.containerId !== undefined) return;
    await startContainer(state, signal);
  };

  const execute = async (
    state: RunState,
    request: SandboxRunRequest,
    cwd: string,
    timeoutMs: number,
    outputLimit: number,
    envVars: Record<string, string>,
  ): Promise<DockerExecutorResult> => {
    const args = ['exec', '-i', '--workdir', cwd];
    for (const [name, value] of Object.entries(envVars)) {
      args.push('-e', `${name}=${value}`);
    }
    args.push(state.containerName, request.command, ...(request.args ?? []));
    return await executor({
      dockerPath,
      containerName: state.containerName,
      args,
      ...(request.input === undefined ? {} : { input: request.input }),
      timeoutMs,
      maxOutputBytes: outputLimit,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  };

  const resetContainer = async (state: RunState): Promise<void> => {
    await removeContainer(state);
    state.containerId = undefined;
    state.containerName = nextContainerName(state.key);
  };

  const cleanupState = async (state: RunState): Promise<void> => {
    if (runs.get(state.key) === state) runs.delete(state.key);
    await removeContainer(state);
    if (!keepWorkspaces) {
      try {
        rmSync(state.workspace, { recursive: true, force: true });
      } catch {
        // Workspace cleanup is best effort.
      }
    }
  };

  const removeContainer = async (state: RunState): Promise<void> => {
    try {
      await executor({
        dockerPath,
        containerName: state.containerName,
        args: ['rm', '-f', state.containerName],
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      });
    } catch {
      // A missing container or unavailable daemon must not block cleanup.
    }
  };

  const sandbox: DockerSandbox = {
    async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
      assertActive();
      validateRequest(request, allowed, network);
      const timeoutMs = positiveInteger(
        request.timeoutMs
          ?? request.capabilities?.resources?.timeoutMs
          ?? request.capabilities?.process?.timeoutMs
          ?? defaultTimeoutMs,
        'timeoutMs',
      );
      const outputLimit = positiveInteger(
        request.maxOutputBytes
          ?? request.capabilities?.resources?.maxOutputBytes
          ?? maxOutputBytes,
        'maxOutputBytes',
      );
      const cwd = containerCwd(
        request.cwd ?? request.capabilities?.filesystem?.cwd,
        containerWorkdir,
      );
      const envVars = {
        ...env,
        ...normalizeEnv(request.env, 'Sandbox request env'),
      };
      const key = request.runId ?? request.toolCallId ?? `call-${randomUUID()}`;
      let state = runs.get(key);
      const ephemeral = state === undefined && request.runId === undefined;
      if (state === undefined) {
        state = {
          key,
          workspace: createWorkspace(providerRoot, key, ephemeral),
          containerName: nextContainerName(key),
          ephemeral,
        };
        runs.set(key, state);
      }

      try {
        await ensureContainer(state, request.signal);
        let result = await execute(state, request, cwd, timeoutMs, outputLimit, envVars);
        if (containerMissing(result)) {
          await resetContainer(state);
          await ensureContainer(state, request.signal);
          result = await execute(state, request, cwd, timeoutMs, outputLimit, envVars);
        }
        if (result.timedOut) await resetContainer(state);
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        };
      } catch (error) {
        if (request.signal?.aborted) await resetContainer(state);
        throw error;
      } finally {
        if (state.ephemeral) await cleanupState(state);
      }
    },

    async cleanupRun(runId: RunId): Promise<void> {
      const state = runs.get(runId);
      if (state === undefined) return;
      await cleanupState(state);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([...runs.values()].map((state) => cleanupState(state)));
      if (!keepWorkspaces) {
        try {
          rmSync(providerRoot, { recursive: true, force: true });
        } catch {
          // Provider cleanup is best effort.
        }
      }
    },

    workspaceFor(runId: RunId): string | undefined {
      return runs.get(runId)?.workspace;
    },
  };
  return sandbox;
}

function validateRequest(
  request: SandboxRunRequest,
  allowed: Set<string>,
  network: 'none' | 'bridge',
): void {
  if (!isRecord(request)) {
    throw invalidRequest('Sandbox request must be an object');
  }
  const command = request.command;
  if (typeof command !== 'string' || !command.trim()) {
    throw invalidRequest('Sandbox command must be non-empty');
  }
  if (!allowed.has(command)) {
    throw new SandboxError('SANDBOX_COMMAND_DENIED', `Command "${command}" is not allowed`);
  }
  if (!request.capabilities?.process?.commands?.includes(command)) {
    throw new SandboxError('SANDBOX_COMMAND_DENIED', `Command "${command}" is not allowed`);
  }
  if (request.capabilities?.network && network === 'none') {
    throw new SandboxError(
      'SANDBOX_NETWORK_UNSUPPORTED',
      'Docker sandbox has no network access; configure network: "bridge" explicitly',
    );
  }
  normalizeArgs(request.args ?? [], 'Sandbox request args');
  if (request.input !== undefined && typeof request.input !== 'string') {
    throw invalidRequest('Sandbox input must be a string');
  }
  normalizeEnv(request.env, 'Sandbox request env');
}

function containerCwd(requested: string | undefined, workdir: string): string {
  const value = requested ?? '.';
  if (typeof value !== 'string' || value.includes('\0')) {
    throw invalidRequest('Sandbox cwd must be a string');
  }
  const resolved = value.startsWith('/')
    ? posix.normalize(value)
    : posix.resolve(workdir, value === '' ? '.' : value);
  if (resolved !== workdir && !resolved.startsWith(`${workdir}/`)) {
    throw new SandboxError('SANDBOX_CWD_DENIED', 'Sandbox cwd must stay inside the workspace');
  }
  return resolved;
}

function createProviderRoot(workspaceRoot: string | undefined): string {
  if (workspaceRoot === undefined) {
    return mkdtempSync(join(tmpdir(), 'fevex-docker-sandbox-'));
  }
  const root = resolve(nonEmpty(workspaceRoot, 'workspaceRoot'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const providerRoot = join(realpathSync(root), `fevex-${randomUUID().slice(0, 8)}`);
  mkdirSync(providerRoot, { recursive: true, mode: 0o700 });
  return providerRoot;
}

function createWorkspace(root: string, key: string, ephemeral: boolean): string {
  if (ephemeral) return mkdtempSync(join(root, 'call-'));
  const workspace = join(root, 'runs', hashKey(key).slice(0, 16));
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  return workspace;
}

function nextContainerName(key: string): string {
  return `fevex-sbx-${hashKey(key).slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

function containerMissing(result: DockerExecutorResult): boolean {
  return result.exitCode !== 0
    && /No such container|is not running|Container .* is not running/i.test(result.stderr);
}

function normalizeCommands(commands: readonly string[]): string[] {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw invalidConfig('Docker sandbox commands must be a non-empty array');
  }
  const normalized = commands.map((command) => nonEmpty(command, 'commands[]'));
  if (new Set(normalized).size !== normalized.length) {
    throw invalidConfig('Docker sandbox commands must be unique');
  }
  return normalized;
}

function normalizeContainerWorkdir(value: string): string {
  const workdir = nonEmpty(value, 'containerWorkdir');
  if (!workdir.startsWith('/') || workdir === '/') {
    throw invalidConfig('Docker sandbox containerWorkdir must be an absolute non-root path');
  }
  const normalized = posix.normalize(workdir);
  if (normalized === '/') {
    throw invalidConfig('Docker sandbox containerWorkdir must be an absolute non-root path');
  }
  return normalized;
}

function normalizeEnv(
  value: Record<string, string> | undefined,
  label: string,
): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalidConfig(`${label} must be an object`);
  const normalized: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!ENV_NAME.test(name)) {
      throw invalidConfig(`${label} contains an invalid variable name: ${name}`);
    }
    if (typeof raw !== 'string' || raw.includes('\0')) {
      throw invalidConfig(`${label}.${name} must be a string without NUL bytes`);
    }
    normalized[name] = raw;
  }
  return normalized;
}

function normalizeArgs(
  value: readonly string[],
  label: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) throw invalidConfig(`${label} must be an array`);
  if (value.length === 0 && options.allowEmpty === false) {
    throw invalidConfig(`${label} must be non-empty`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.includes('\0')) {
      throw invalidConfig(`${label} must contain strings without NUL bytes`);
    }
    return item;
  });
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidConfig(`Docker sandbox ${label} must be non-empty`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidConfig(`Docker sandbox ${label} must be a positive safe integer`);
  }
  return value as number;
}

function invalidConfig(message: string): SandboxError {
  return new SandboxError('SANDBOX_INVALID_CONFIG', message);
}

function invalidRequest(message: string): SandboxError {
  return new SandboxError('SANDBOX_INVALID_REQUEST', message);
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function limitMessage(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
