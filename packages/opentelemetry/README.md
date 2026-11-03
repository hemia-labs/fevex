# @fevex/opentelemetry

> **Publication status:** validated in CI but not published to npm. Use this
> package from the Fevex repository until it is published.

OpenTelemetry adapter for Fevex traces and metrics.

```bash
npm install @fevex/core @fevex/opentelemetry @opentelemetry/api
```

The install command above applies once the package is published to npm.

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

The exporter creates root, model, tool and coordinator step spans using Fevex
trace timestamps. Workflow and team roots carry `fevex.run.kind`; correlated
runs carry `fevex.parent_run.id` and `fevex.root_run.id`, and steps expose
`fevex.child_run.id`. It also emits `fevex.run.count`, `fevex.run.duration`,
`fevex.model.duration`, `fevex.model.tokens`, `fevex.tool.duration` and
`fevex.run.cost`. Metrics avoid run and session IDs as labels.
