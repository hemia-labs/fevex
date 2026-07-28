# @fevex/mcp

MCP Streamable HTTP adapter for Fevex connections.

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
