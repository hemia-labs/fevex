# @fevex/openapi

OpenAPI 3.1 JSON adapter for Fevex connections.

```ts
import { defineConnection } from '@fevex/core';
import { createOpenApiToolProvider } from '@fevex/openapi';

const billing = defineConnection({
  name: 'billing',
  provider: createOpenApiToolProvider({
    document: openApiDocument,
    operations: { allow: ['getInvoice'] },
    headers: ({ context }) => ({ Authorization: `Bearer ${context?.actor?.id}` }),
  }),
  allowlist: ['getInvoice'],
});
```

Only bundled JSON OpenAPI 3.1.x documents and JSON request/response bodies are
supported in v1. YAML, remote refs, multipart, form-urlencoded and binary
payloads are intentionally out of scope.
