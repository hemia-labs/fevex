# Test MCP server

Minimal NestJS app exposing a stateless MCP Streamable HTTP endpoint.

```bash
bun run dev:mcp
```

The server listens on `http://localhost:3002` and exposes `echo`, `sum`,
`multiply`, `slugify` and `word_count` at `http://localhost:3002/mcp`.
Set `MCP_PORT` to use another port.

The Nest API demo registers this server as the Fevex connection `nest_mcp`, so
the playground timeline can show `Usando MCP nest_mcp` for its tool events.
