import {
  context,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace as apiTrace,
  type Attributes,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import type {
  RunTrace,
  TraceContent,
  TraceExporter,
  TraceSpan,
  TraceStatus,
} from '@fevex/core/observability';

export interface OpenTelemetryExporterOptions {
  tracer?: Tracer;
  meter?: Meter;
  instrumentationName?: string;
}

function status(status: TraceStatus): { code: SpanStatusCode } {
  return { code: status === 'completed' ? SpanStatusCode.OK : SpanStatusCode.ERROR };
}

function contentAttributes(items: readonly TraceContent[] | undefined): Attributes {
  return Object.fromEntries(
    (items ?? []).map((item) => [`fevex.content.${item.kind}`, JSON.stringify(item.value)]),
  );
}

function attributes(value: Record<string, unknown> | undefined): Attributes | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      item === null || typeof item === 'object' ? JSON.stringify(item) : item,
    ]),
  ) as Attributes;
}

function addAnnotations(span: Span, item: RunTrace | TraceSpan): void {
  for (const annotation of item.annotations) {
    span.addEvent(annotation.name, attributes(annotation.attributes), new Date(annotation.timestamp));
  }
}

function spanAttributes(item: TraceSpan, run: RunTrace): Attributes {
  if (item.kind === 'model') {
    return {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': run.model?.model ?? run.modelRegistryName,
      ...(run.model?.provider ? { 'gen_ai.provider.name': run.model.provider } : {}),
      ...(item.usage?.inputTokens === undefined
        ? {}
        : { 'gen_ai.usage.input_tokens': item.usage.inputTokens }),
      ...(item.usage?.outputTokens === undefined
        ? {}
        : { 'gen_ai.usage.output_tokens': item.usage.outputTokens }),
      ...contentAttributes(item.content),
    };
  }
  return {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': item.attributes.toolName as string,
    'gen_ai.tool.call.id': item.attributes.toolCallId as string,
    'fevex.tool.attempt': item.attributes.attempt as number,
    ...contentAttributes(item.content),
  };
}

export function createOpenTelemetryExporter(
  options: OpenTelemetryExporterOptions = {},
): TraceExporter {
  const instrumentationName = options.instrumentationName ?? '@fevex/opentelemetry';
  const tracer = options.tracer ?? apiTrace.getTracer(instrumentationName);
  const meter = options.meter ?? metrics.getMeter(instrumentationName);
  const runCount = meter.createCounter('fevex.run.count');
  const runDuration = meter.createHistogram('fevex.run.duration', { unit: 's' });
  const modelDuration = meter.createHistogram('fevex.model.duration', { unit: 's' });
  const modelTokens = meter.createCounter('fevex.model.tokens', { unit: '{token}' });
  const toolDuration = meter.createHistogram('fevex.tool.duration', { unit: 's' });
  const runCost = meter.createCounter('fevex.run.cost');

  return {
    export(run) {
      const rootAttributes: Attributes = {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': run.agentName,
        'fevex.run.id': run.runId,
        'fevex.session.id': run.sessionId,
        'fevex.model.registry_name': run.modelRegistryName,
        ...(run.model?.provider ? { 'gen_ai.provider.name': run.model.provider } : {}),
        ...(run.model?.model ? { 'gen_ai.request.model': run.model.model } : {}),
        ...contentAttributes(run.content),
      };
      const root = tracer.startSpan(
        `invoke_agent ${run.agentName}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: new Date(run.startedAt),
          attributes: rootAttributes,
        },
        context.active(),
      );
      const rootContext = apiTrace.setSpan(context.active(), root);
      addAnnotations(root, run);

      for (const item of run.spans) {
        const child = tracer.startSpan(
          item.kind === 'model'
            ? `chat ${run.model?.model ?? run.modelRegistryName}`
            : `execute_tool ${item.name}`,
          {
            kind: item.kind === 'model' ? SpanKind.CLIENT : SpanKind.INTERNAL,
            startTime: new Date(item.startedAt),
            attributes: spanAttributes(item, run),
          },
          rootContext,
        );
        addAnnotations(child, item);
        child.setStatus(status(item.status));
        child.end(new Date(item.endedAt));

        if (item.kind === 'model') {
          const labels = {
            status: item.status,
            provider: run.model?.provider ?? 'unknown',
            model: run.model?.model ?? run.modelRegistryName,
          };
          modelDuration.record(item.durationMs / 1_000, labels);
          if (item.usage?.inputTokens !== undefined) {
            modelTokens.add(item.usage.inputTokens, { ...labels, 'token.type': 'input' });
          }
          if (item.usage?.outputTokens !== undefined) {
            modelTokens.add(item.usage.outputTokens, { ...labels, 'token.type': 'output' });
          }
        } else {
          toolDuration.record(item.durationMs / 1_000, {
            status: item.status,
            'tool.name': item.name,
          });
        }
      }

      root.setStatus(status(run.status));
      root.end(new Date(run.endedAt));
      const runLabels = { status: run.status, 'agent.name': run.agentName };
      runCount.add(1, runLabels);
      runDuration.record(run.durationMs / 1_000, runLabels);
      if (run.cost) runCost.add(run.cost.amount, { ...runLabels, currency: run.cost.currency });
    },
  };
}
