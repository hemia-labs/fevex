import {
  context,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace as apiTrace,
  type Attributes,
  type Context,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import type {
  RunTrace,
  TraceContent,
  TraceExporter,
  TraceRunKind,
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
      'gen_ai.request.model': run.model?.model ?? run.modelRegistryName ?? 'unknown',
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
  if (item.kind === 'step') {
    return {
      'fevex.step.id': item.attributes.stepId as string,
      'fevex.step.kind': item.attributes.stepKind as string,
      ...(typeof item.attributes.agentName === 'string'
        ? { 'gen_ai.agent.name': item.attributes.agentName }
        : {}),
      ...(typeof item.attributes.action === 'string'
        ? { 'fevex.team.action': item.attributes.action }
        : {}),
      ...(typeof item.attributes.childRunId === 'string'
        ? { 'fevex.child_run.id': item.attributes.childRunId }
        : {}),
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

function runKind(run: RunTrace): TraceRunKind {
  return run.kind ?? 'agent';
}

function runOperation(kind: TraceRunKind): string {
  if (kind === 'workflow') return 'invoke_workflow';
  if (kind === 'team') return 'invoke_team';
  return 'invoke_agent';
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
      const kind = runKind(run);
      const rootRunId = run.rootRunId ?? run.runId;
      const rootAttributes: Attributes = {
        'gen_ai.operation.name': runOperation(kind),
        'fevex.run.kind': kind,
        'fevex.run.name': run.agentName,
        'fevex.run.id': run.runId,
        'fevex.session.id': run.sessionId,
        'fevex.root_run.id': rootRunId,
        ...(run.parentRunId ? { 'fevex.parent_run.id': run.parentRunId } : {}),
        ...(kind === 'agent' ? { 'gen_ai.agent.name': run.agentName } : {}),
        ...(run.modelRegistryName
          ? { 'fevex.model.registry_name': run.modelRegistryName }
          : {}),
        ...(run.model?.provider ? { 'gen_ai.provider.name': run.model.provider } : {}),
        ...(run.model?.model ? { 'gen_ai.request.model': run.model.model } : {}),
        ...contentAttributes(run.content),
      };
      const root = tracer.startSpan(
        `${runOperation(kind)} ${run.agentName}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: new Date(run.startedAt),
          attributes: rootAttributes,
        },
        context.active(),
      );
      const rootContext = apiTrace.setSpan(context.active(), root);
      const contexts = new Map<string, Context>([[run.runId, rootContext]]);
      addAnnotations(root, run);

      for (const item of run.spans) {
        const parentContext = contexts.get(item.parentId) ?? rootContext;
        const child = tracer.startSpan(
          item.kind === 'model'
            ? `chat ${run.model?.model ?? run.modelRegistryName ?? 'unknown'}`
            : item.kind === 'step'
              ? `step ${item.name}`
              : `execute_tool ${item.name}`,
          {
            kind: item.kind === 'model' ? SpanKind.CLIENT : SpanKind.INTERNAL,
            startTime: new Date(item.startedAt),
            attributes: spanAttributes(item, run),
          },
          parentContext,
        );
        contexts.set(item.id, apiTrace.setSpan(parentContext, child));
        addAnnotations(child, item);
        child.setStatus(status(item.status));
        child.end(new Date(item.endedAt));

        if (item.kind === 'model') {
          const labels = {
            status: item.status,
            provider: run.model?.provider ?? 'unknown',
            model: run.model?.model ?? run.modelRegistryName ?? 'unknown',
          };
          modelDuration.record(item.durationMs / 1_000, labels);
          if (item.usage?.inputTokens !== undefined) {
            modelTokens.add(item.usage.inputTokens, { ...labels, 'token.type': 'input' });
          }
          if (item.usage?.outputTokens !== undefined) {
            modelTokens.add(item.usage.outputTokens, { ...labels, 'token.type': 'output' });
          }
        } else if (item.kind === 'tool') {
          toolDuration.record(item.durationMs / 1_000, {
            status: item.status,
            'tool.name': item.name,
          });
        }
      }

      root.setStatus(status(run.status));
      root.end(new Date(run.endedAt));
      const runLabels = {
        status: run.status,
        kind,
        'agent.name': run.agentName,
      };
      runCount.add(1, runLabels);
      runDuration.record(run.durationMs / 1_000, runLabels);
      if (run.cost) runCost.add(run.cost.amount, { ...runLabels, currency: run.cost.currency });
    },
  };
}
