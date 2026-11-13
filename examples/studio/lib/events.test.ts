import { describe, expect, test } from 'bun:test';
import type { AgentEvent, JsonValue } from '@fevex/core';
import { buildTimeline, summarizeRun, titleForType } from './events';
import { durationMs, formatDuration, runKind, runName, statusLabel } from './format';

let sequence = 0;

function event<T extends AgentEvent['type']>(
  type: T,
  payload?: unknown,
  timestamp = '2026-11-12T10:00:00.000Z',
): AgentEvent {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    sequence,
    runId: 'run-1',
    timestamp,
    type,
    ...(payload === undefined ? {} : { payload }),
  } as AgentEvent;
}

describe('run events', () => {
  test('summarizes tools, failures and streamed output', () => {
    const summary = summarizeRun([
      event('tool.started', { step: 1, toolCallId: 'a', toolName: 'lookup' }),
      event('tool.completed', { step: 1, toolCallId: 'a', toolName: 'lookup' }),
      event('tool.started', { step: 2, toolCallId: 'b', toolName: 'refund' }),
      event('tool.failed', {
        step: 2,
        toolCallId: 'b',
        toolName: 'refund',
        error: 'card declined',
        errorCode: 'CARD_DECLINED',
      }),
      event('model.output.delta', { step: 1, delta: 'Hello ' }),
      event('model.output.delta', { step: 1, delta: 'world' }),
      event('run.failed', { error: 'tool failed', errorCode: 'TOOL_FAILED' }),
    ]);

    expect(summary.tools).toMatchObject([
      { id: 'a', name: 'lookup', status: 'completed' },
      { id: 'b', name: 'refund', status: 'failed', error: 'card declined' },
    ]);
    expect(summary.failures.map(({ message }) => message)).toEqual([
      'card declined',
      'tool failed',
    ]);
    expect(summary.output).toBe('Hello world');
    expect(summary.lastEventAt).toBe('2026-11-12T10:00:00.000Z');
  });

  test('groups streamed deltas and keeps event order', () => {
    const timeline = buildTimeline([
      event('run.started'),
      event('model.output.delta', { step: 1, delta: 'A' }),
      event('model.output.delta', { step: 1, delta: 'B' }),
      event('tool.started', { step: 1, toolCallId: 'a', toolName: 'lookup' }),
      event('model.output.delta', { step: 2, delta: 'C' }),
      event('run.completed', { output: 'AB' }),
    ]);

    expect(timeline.map(({ type }) => type)).toEqual([
      'run.started',
      'model.output.delta',
      'tool.started',
      'model.output.delta',
      'run.completed',
    ]);
    expect(timeline[1]).toMatchObject({ detail: 'AB', count: 2 });
    expect(timeline[3]).toMatchObject({ detail: 'C', count: 1 });
    expect(timeline[2]?.severity).toBe('info');
    expect(timeline[4]?.severity).toBe('success');
  });

  test('labels known and workflow events', () => {
    expect(titleForType('tool.failed')).toBe('Tool falló');
    expect(titleForType('workflow.step.completed')).toBe('Workflow Step Completed');
  });
});

describe('run formatting', () => {
  const run = {
    id: 'run-1',
    sessionId: 'session-1',
    kind: 'workflow' as const,
    workflowName: 'refund-flow',
    status: 'completed' as const,
    revision: 1,
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:01:05.000Z',
    output: 'done' as JsonValue,
  };

  test('reads kind and name', () => {
    expect(runKind(run)).toBe('workflow');
    expect(runName(run)).toBe('refund-flow');
    expect(statusLabel('paused')).toBe('Pausado');
  });

  test('formats durations', () => {
    expect(durationMs(run)).toBe(65_000);
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });
});
