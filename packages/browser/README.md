# @fevex/browser

Curated `browser__*` navigation tools for Fevex, backed by the external
[`agent-browser`](https://github.com/vercel-labs/agent-browser) binary.

Fevex keeps the contracts, schemas, approvals, limits, events and cancellation;
`agent-browser` keeps Chrome, sessions, snapshots and navigation actions. The
binary runs **inside the run's sandbox** via `context.sandbox`.

```ts
import { createFevex, defineAgent } from '@fevex/core';
import { createBrowserTools } from '@fevex/browser';

const browserTools = createBrowserTools({
  expectedVersion: '1.2.3',                 // exact agent-browser version in the sandbox image
  allowedDomains: ['docs.example.com', '*.cdn.example.com'],
  network: { allow: ['docs.example.com'] }, // sandbox network capability
  contentBoundaries: true,
  maxOutputChars: 50_000,
  idleTimeoutMs: 5 * 60 * 1000,
});

createFevex({
  models: {},
  agents: [
    defineAgent({
      name: 'researcher',
      instructions: 'Research within the allowed docs.',
      tools: ['browser__navigate', 'browser__snapshot', 'browser__read'],
    }),
  ],
  tools: browserTools,
  sandbox, // a network-capable Sandbox provider (see below)
});
```

## Tools

| Tool | Risk | Notes |
|---|---|---|
| `browser__navigate` | read | Opens a URL; enforced against `allowedDomains`. |
| `browser__snapshot` | read | Accessibility snapshot with stable refs (`@e1`). |
| `browser__read` | read | Reads page or element text. |
| `browser__get` | read | Reads an element attribute/property. |
| `browser__click` | write | `approval: "required"` by default. |
| `browser__fill` | write | `approval: "required"` by default. |
| `browser__wait` | write | Waits for a condition or settle. |
| `browser__tabs` | write | List/new/select/close tabs. |
| `browser__close` | write | Closes the run's browser session. |

`browser__screenshot` is **deferred** until the `@fevex/core/artifacts` contract
exists — a screenshot must cross the boundary as an artifact reference, never
base64 or an internal path.

## Requirements

- **`agent-browser` is not a dependency.** The sandbox image installs the exact
  binary; this package verifies the version on first use (`expectedVersion`).
  This keeps the Node 20 floor of `@fevex/core` even though `agent-browser`
  requires Node 24.
- **A network-capable sandbox.** The built-in `LocalSandbox` rejects network
  access by design and is not suitable here; production needs a provider with
  restricted network and per-run session affinity (e.g. `@fevex/sandbox-docker`
  or `@fevex/sandbox-e2b`). Never declare a fake capability to bypass this.
- Session naming is derived from `runId`, so the sandbox must keep the process,
  filesystem and sockets alive across tool calls of the same run.

## Security

- `allowedDomains` is enforced locally **and** passed as `--allowed-domains`.
- `--content-boundaries` is on by default; page content is still untrusted input
  and may contain prompt injection. The runtime never lets a page change
  allowlists, approvals, credentials or enabled tools.
- Not exposed in v1: `chat`, cookies/storage, Chrome profiles/CDP, plugins,
  arbitrary Chrome args, `evaluate`, upload, download, clipboard and network
  interception.
- Errors are normalized to `IntegrationError` with safe messages; stdout/stderr
  and sensitive headers never enter the run history.
