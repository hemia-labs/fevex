# MCP documentation and OpenAPI account examples

For a combined research agent, real model configuration and evidence evals,
see [research](../research/). It shares these fixtures with the playground.

From the repository root, after installing workspace dependencies:

```bash
bun run examples/connections/index.ts
```

The script starts a temporary HTTP service on `127.0.0.1` with an automatically
assigned port and closes it in `finally`. It requires Bun, but no VM, external
service, API key or browser. The model is deterministic: its tool calls and final
answers are scripted. The MCP and OpenAPI adapters perform actual local HTTP
requests through the Fevex agent loop.

| Agent | Connection | What it demonstrates |
| --- | --- | --- |
| `researcher` | MCP `docs__search` | Initialization, tool discovery and searching the repository's public Markdown documentation with source URLs. |
| `support` | OpenAPI `accounts__getAccount` | Turning an OpenAPI 3.1 operation into a tool, encoding a path parameter and validating the JSON response. |

The checks confirm one documentation search and one account request, tool results
in the model's next step, and connection identity in `tool.completed` events.
Both remote catalogs describe write tools; explicit allowlists expose only the
read tools to the agents. The fixture does not implement the write operations.

To check the example's types:

```bash
bun x tsc -p examples/connections/tsconfig.json
```

## Connecting real services

Keep the `defineConnection` and `defineAgent` setup in `index.ts`. Replace the
MCP URL with a trusted Streamable HTTP endpoint. For OpenAPI, use a bundled JSON
3.1.x document and set `baseUrl` to the service origin. Inputs are grouped as
`path`, `query`, `header`, `cookie` and `body` according to the operation schema;
the account example sends `{ path: { id: 42 } }`.

Replace `fakeModel` with an official OpenAI or DeepSeek gateway when you want the
model to choose calls and compose answers. The assertions inspect `fakeModel`
recordings and belong to this deterministic demo; adapt them when changing the
model or service data. The local fixture and scripted answers are not a quality
evaluation of a real model.

Resolve credentials in the host and pass trusted `headers` to the provider.
Scope each MCP provider to one identity/credential set. Derive actor identity
from authenticated input, authorize resource access, and keep endpoint URLs out
of model-controlled input. Discovery metadata does not grant permission:
allowlists, risk, approvals and policies remain local configuration. These
examples deliberately expose read operations; add write tools only with the
appropriate local controls.

The fixture implements only the MCP methods needed here and returns one
synthetic account. For a complete server backed by the installed MCP SDK, see
[`examples/nest-mcp`](../nest-mcp/). Neither Fevex adapter requires that SDK in
the core runtime.
