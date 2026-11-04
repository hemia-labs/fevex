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

The `protocolVersion` option only accepts `2026-07-28`. Multi-round-trip
requests are not implemented yet: an `input_required` result fails with
`MCP_INPUT_REQUIRED`.

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

Only Streamable HTTP is supported. `stdio`, resources, prompts, sampling,
elicitation and legacy HTTP+SSE are intentionally out of scope for this package.

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
the matching SSE response. Limits raise `MCP_DISCOVERY_LIMIT`; repeated non-empty
cursors raise `MCP_CURSOR_REPEATED`. Partial discovery results are not returned.
