# Test MCP server

Minimal NestJS app exposing a stateless MCP `2026-07-28` Streamable HTTP
endpoint.

```bash
bun run dev:mcp
```

The server listens on `http://localhost:3002` and exposes `echo`, `sum`,
`multiply`, `slugify` and `word_count` at `http://localhost:3002/mcp`.
Set `MCP_PORT` to use another port.

The endpoint implements the stateless subset used by the Fevex example:
`server/discover`, `tools/list`, `tools/call`, per-request `_meta`, and the
`MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. It does not use
sessions or the legacy `initialize` handshake.

The official MCP SDK used by earlier versions of this example still negotiates
`2025-11-25`, so this server is implemented directly against the
`2026-07-28` request shape. Replace it with the SDK when its supported protocol
versions include `2026-07-28`.

The Nest API demo registers this server as the Fevex connection `nest_mcp`, so
the playground timeline can show `Usando MCP nest_mcp` for its tool events.
