# @fevex/opentelemetry

OpenTelemetry adapter for Fevex traces and metrics.

```bash
npm install @fevex/core @fevex/opentelemetry @opentelemetry/api
```

Configure an OpenTelemetry SDK in the application, then pass the exporter to
`createFevex`:

```ts
import { createFevex } from '@fevex/core';
import { createOpenTelemetryExporter } from '@fevex/opentelemetry';

const app = createFevex({
  models,
  agents,
  tools,
  observability: {
    exporters: [createOpenTelemetryExporter()],
  },
});

await app.runAgent('support', { input: 'Hello' });
await app.flushObservability();
```

The package uses only the OpenTelemetry API. SDK initialization, OTLP
configuration and shutdown remain application responsibilities.

The exporter creates root, model and tool spans using Fevex trace timestamps.
It also emits `fevex.run.count`, `fevex.run.duration`,
`fevex.model.duration`, `fevex.model.tokens`, `fevex.tool.duration` and
`fevex.run.cost`. Metrics avoid run and session IDs as labels.
