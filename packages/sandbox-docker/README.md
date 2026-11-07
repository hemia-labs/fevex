# @fevex/sandbox-docker

> **Publication status:** validated in CI but not published to npm. Use this
> package from the Fevex repository until it is published.

Docker-backed production sandbox provider for Fevex. It implements the
`Sandbox` contract with one long-lived container per run, a private workspace
and resource limits, so tools can keep files, processes and sockets across tool
calls without sharing them with another run.

```ts
import { createFevex, defineAgent } from '@fevex/core';
import { createDockerSandbox } from '@fevex/sandbox-docker';

const sandbox = createDockerSandbox({
  image: 'oven/bun:1-alpine',
  commands: ['bun', 'node', 'sh'],
  workspaceRoot: '/var/lib/fevex/sandboxes',
  memory: '512m',
  cpus: 1,
  pidsLimit: 128,
});

const app = createFevex({
  models: { default: model },
  agents: [
    defineAgent({
      name: 'coder',
      instructions: 'Run the project checks.',
      tools: ['run_tests'],
    }),
  ],
  tools: [runTests],
  sandbox,
});
```

A tool must declare the command it needs:

```ts
const runTests = defineTool({
  name: 'run_tests',
  sandbox: {
    process: { commands: ['bun'] },
    resources: { timeoutMs: 120_000, maxOutputBytes: 64_000 },
  },
  async execute(_input, context) {
    const result = await context.sandbox!.run({
      command: 'bun',
      args: ['test'],
    });
    return result.stdout;
  },
});
```

## Isolation

Each run receives:

- A dedicated container and bind-mounted workspace under `workspaceRoot`.
- `--network none` unless `network: 'bridge'` is configured explicitly.
- `--cap-drop ALL`, `no-new-privileges`, a read-only root and a private
  `noexec` `/tmp`.
- `--pids-limit`, optional memory and CPU limits.
- Only the environment variables explicitly configured on the provider or the
  request. Host environment variables are never forwarded.
- A command allowlist enforced both by the provider and by the tool's
  `sandbox.process.commands` capability.

The container runs `tail -f /dev/null` (configurable with `keepAliveCommand`) to
stay alive between calls. If a call times out or is aborted, the container is
killed and recreated on the next call while the workspace remains available.

## Lifecycle

Fevex calls `cleanupRun(runId)` when a run reaches a terminal state and
`dispose()` during `app.shutdown()`. Both remove containers and workspaces.
Paused runs keep their container and workspace so a resume can continue.
Docker does not provide live process snapshots; pause/resume keeps the container
alive instead.

Automatic cleanup removes the workspace as soon as the run finishes. To promote
files after the run, set `keepWorkspaces: true` and delete the
`workspaceFor(runId)` directory yourself, or write through `context.artifacts`
while the tool is executing:

```ts
const workspace = sandbox.workspaceFor(runId);
await artifacts.put({
  filename: 'report.txt',
  mimeType: 'text/plain',
  bytes: await Bun.file(`${workspace}/report.txt`).bytes(),
});
```

Set `keepWorkspaces: true` to inspect workspaces after a run; you are then
responsible for deleting them.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `image` | required | Image used for every run |
| `commands` | required | Provider command allowlist |
| `workspaceRoot` | temporary directory | Host directory for provider workspaces |
| `dockerPath` | `docker` | Docker CLI executable |
| `containerWorkdir` | `/workspace` | Absolute workdir inside the container |
| `network` | `none` | `none` or `bridge` |
| `defaultTimeoutMs` | `10000` | Default command timeout |
| `maxOutputBytes` | `64000` | Byte cap for stdout and stderr separately |
| `startupTimeoutMs` | `15000` | Time allowed for `docker run -d` |
| `env` | none | Extra environment variables for every exec |
| `memory` | Docker default | Memory limit, for example `512m` |
| `cpus` | Docker default | CPU limit, for example `1.5` |
| `pidsLimit` | `128` | Process limit |
| `user` | image user | User inside the container |
| `init` | `true` | Use Docker's init process |
| `dockerArgs` | none | Extra `docker run` arguments |
| `keepWorkspaces` | `false` | Keep workspaces after cleanup |
| `executor` | Docker CLI | Injectable runner for tests |

## Network

`network: 'bridge'` gives the container broad egress. Docker alone does not
enforce per-destination allowlists. If a tool needs an allowlist, put a proxy or
an egress-filtered Docker network in front and keep domain validation in the
tool. `LocalSandbox` remains development-only and rejects network access.

## Requirements

- Docker Engine or Docker Desktop with a running daemon.
- The image must already exist locally; the provider does not pull images at
  runtime.
- The image must contain the keep-alive command (`tail` by default) and every
  command in the allowlist.
- On Docker Desktop, `workspaceRoot` must be inside a shared path such as
  `/Users`, `/Volumes` or `/private`.
