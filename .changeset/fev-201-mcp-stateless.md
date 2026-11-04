---
"@fevex/mcp": minor
---

Migrate the MCP adapter to the stateless `2026-07-28` Streamable HTTP revision.
Remove `initialize`, `notifications/initialized` and `Mcp-Session-Id`; send
per-request `_meta`, `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`; verify
servers through `server/discover`. Legacy `2025-11-25` servers now fail with an
actionable `MCP_VERSION_UNSUPPORTED` error, and `input_required` results fail
with `MCP_INPUT_REQUIRED` until MRTR support lands.
