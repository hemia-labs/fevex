import { describe, expect, test } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { RunTrace } from '@fevex/core/observability';
import { createOpenTelemetryExporter } from './index';

describe('createOpenTelemetryExporter', () => {
  test('emits parented GenAI spans and low-cardinality metrics', async () => {
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000,
    });
    const meterProvider = new MeterProvider({ readers: [reader] });
    const exporter = createOpenTelemetryExporter({
      tracer: tracerProvider.getTracer('test'),
      meter: meterProvider.getMeter('test'),
    });
    const run: RunTrace = {
      schemaVersion: '1',
      traceId: 'run-1',
      runId: 'run-1',
      sessionId: 'session-1',
      agentName: 'support',
      modelRegistryName: 'default',
      model: { provider: 'openai', model: 'gpt-test' },
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:00.100Z',
      durationMs: 100,
      status: 'completed',
      attributes: { eventCount: 6 },
      annotations: [{ name: 'run.resumed', timestamp: '2026-01-01T00:00:00.010Z' }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      cost: { amount: 0.02, currency: 'USD' },
      spans: [
        {
          id: 'model-1',
          parentId: 'run-1',
          kind: 'model',
          name: 'model step 1',
          startedAt: '2026-01-01T00:00:00.010Z',
          endedAt: '2026-01-01T00:00:00.050Z',
          durationMs: 40,
          status: 'completed',
          attributes: { step: 1 },
          annotations: [],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
        {
          id: 'tool-1',
          parentId: 'run-1',
          kind: 'tool',
          name: 'lookup',
          startedAt: '2026-01-01T00:00:00.050Z',
          endedAt: '2026-01-01T00:00:00.080Z',
          durationMs: 30,
          status: 'failed',
          attributes: {
            step: 1,
            toolCallId: 'call-1',
            toolName: 'lookup',
            attempt: 1,
          },
          annotations: [],
        },
      ],
    };

    await exporter.export(run);
    await tracerProvider.forceFlush();
    await meterProvider.forceFlush();

    const spans = spanExporter.getFinishedSpans();
    expect(spans.map(({ name }) => name)).toEqual([
      'chat gpt-test',
      'execute_tool lookup',
      'invoke_agent support',
    ]);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(spans[0]?.parentSpanContext?.spanId).toBe(spans[2]?.spanContext().spanId);
    expect(spans[0]?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-test',
      'gen_ai.usage.input_tokens': 10,
    });
    expect(spans[1]?.status.code).not.toBe(spans[0]?.status.code);

    const metricNames = metricExporter
      .getMetrics()
      .flatMap(({ scopeMetrics }) =>
        scopeMetrics.flatMap(({ metrics: exportedMetrics }) =>
          exportedMetrics.map(({ descriptor }) => descriptor.name),
        ),
      );
    expect(metricNames).toEqual(
      expect.arrayContaining([
        'fevex.run.count',
        'fevex.run.duration',
        'fevex.model.duration',
        'fevex.model.tokens',
        'fevex.tool.duration',
        'fevex.run.cost',
      ]),
    );
    const serializedMetrics = JSON.stringify(metricExporter.getMetrics());
    expect(serializedMetrics).not.toContain('run-1');
    expect(serializedMetrics).not.toContain('session-1');

    await tracerProvider.shutdown();
    await meterProvider.shutdown();
  });
});
