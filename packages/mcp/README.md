# @fevex/mcp

> **Publication status:** validated in CI but not published to npm. Use this
> package from the Fevex repository until it is published.

MCP Streamable HTTP adapter for Fevex connections.

## Protocol

This adapter targets MCP `2026-07-28` Streamable HTTP:

- no `initialize`/`notifications/initialized` handshake and no `Mcp-Session-Id`;
- every request carries `io.modelcontextprotocol/protocolVersion`,
  `io.modelcontextprotocol/clientInfo` and
  `io.modelcontextprotocol/clientCapabilities` in `params._meta`;
- `server/discover` runs once per provider to verify supported versions and the
  tools capability;
- requests send the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers;
- servers that only implement legacy handshake versions `2025-11-25` or earlier
  fail with `MCP_VERSION_UNSUPPORTED` and an actionable message.

The `protocolVersion` option only accepts `2026-07-28`.

```ts
import { createFevex, defineAgent, defineConnection } from '@fevex/core';
import { createMcpToolProvider } from '@fevex/mcp';

const docs = defineConnection({
  name: 'docs',
  provider: createMcpToolProvider({
    url: 'https://example.com/mcp',
    headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
  }),
  allowlist: ['search'],
  tools: {
    search: {
      description: 'Search internal docs.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
});

createFevex({
  models: {},
  agents: [defineAgent({
    name: 'assistant',
    instructions: 'Help.',
    tools: ['docs__search'],
  })],
  connections: [docs],
});
```

Only Streamable HTTP is supported. `stdio`, resources, prompts, sampling, roots
and legacy HTTP+SSE are intentionally out of scope for this package.

## MRTR, Tasks and subscriptions

**MRTR elicitation.** Configure `onElicitation` to receive
`elicitation/create` requests from `input_required` results:

```ts
const provider = createMcpToolProvider({
  url: 'https://example.com/mcp',
  onElicitation({ message, requestedSchema }) {
    return { action: 'accept', content: { approved: true } };
  },
});
```

The adapter declares the elicitation client capability only when the handler is
present, echoes the opaque `requestState`, retries with `inputResponses`, and
caps consecutive rounds with `maxInputRounds` (default 5). Sampling and roots
input requests fail with `MCP_INPUT_UNSUPPORTED`.

**Tasks.** The adapter declares the `io.modelcontextprotocol/tasks` extension.
When a tool returns `resultType: "task"`, it polls `tasks/get`, honors
`pollIntervalMs`, sends `tasks/update` for `input_required` task input, and
cancels best-effort on abort or deadline. Use `maxTaskWaitMs` (default 1 hour)
and `taskPollIntervalMs` (fallback 1 second) to bound polling.

**Subscriptions.** Opt into change notifications with `subscriptions` and
receive them through `onNotification`:

```ts
const provider = createMcpToolProvider({
  url: 'https://example.com/mcp',
  subscriptions: { toolsListChanged: true },
  onNotification(notification) {
    if (notification.method === 'notifications/tools/list_changed') {
      // Invalidate any host-side catalog cache.
    }
  },
});
```

The listener opens `subscriptions/listen` after discovery and stays open until
`provider.close()` aborts it. Call `close()` during host shutdown; Fevex does
not own connection-provider lifecycle. The core still resolves `tools/list` per
tool resolution; notification callbacks let the host invalidate its own cache.

Use `onElicitation` for short interactive input. For approvals that may wait for
minutes or survive a restart, the server should use a Task and expose
`input_required` through `tasks/get` instead.

## Connection ownership and recovery

Use one provider instance per identity/credential set. All resolved custom headers
are bound on first use. A later change raises `MCP_IDENTITY_CHANGED` before any
request is sent, including tool calls. Create a new provider when rotating a token
or changing tenants. Dynamic headers must resolve to stable values for that
instance; do not put per-request trace IDs in them. Resolve trusted credentials
in the host, and scope the connection/runtime to that identity. This check does
not replace host authorization.

Concurrent calls with the same headers share `server/discover`. If discovery
fails, a later call can try again on the same instance. The adapter does not
automatically replay failed tool calls, which may have produced external effects.

The core does not cache tool catalogs across tool resolutions. This avoids sharing
catalogs between contexts and retaining failed discovery promises, at the cost of
additional `tools/list` requests. Custom providers are responsible for isolating
any catalog caches they maintain internally.

## Discovery limits

All limits are configurable positive safe integers:

| Option | Default | Scope |
| --- | --- | --- |
| `maxDiscoveryPages` | 100 | Requests per discovery |
| `maxDiscoveryTools` | 1,000 | All returned entries across pages, including malformed entries |
| `maxDiscoveryBytes` | 4 MiB | Cumulative response bytes across discovery pages |
| `requestTimeoutMs` | 30,000 | Each HTTP request, including response consumption |

`maxDiscoveryBytes` also caps each `server/discover` and tool-call response. JSON
and SSE are read incrementally; streams are cancelled on limit failure and after
the matching SSE response.

| Runtime option | Default | Scope |
| --- | --- | --- |
| `maxInputRounds` | 5 | Consecutive MRTR retries for one tool call |
| `maxTaskWaitMs` | 1 hour | Total wait for one MCP task |
| `taskPollIntervalMs` | 1,000 | Fallback polling interval when the task omits one | Limits raise `MCP_DISCOVERY_LIMIT`; repeated non-empty
cursors raise `MCP_CURSOR_REPEATED`. Partial discovery results are not returned.
