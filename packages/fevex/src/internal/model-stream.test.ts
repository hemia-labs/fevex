import { describe, expect, test } from 'bun:test';
import type { ModelGateway, ModelInput } from '../models';
import { readModelStream } from './model-stream';

const input = (signal?: AbortSignal): ModelInput => ({
  messages: [{ role: 'user', content: 'test' }],
  signal,
});

async function collect(model: ModelGateway, signal?: AbortSignal) {
  const stream = readModelStream(model, input(signal));
  const deltas: string[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) return { deltas, result: next.value };
    deltas.push(next.value);
  }
}

describe('model stream consumer', () => {
  test('delivers the first delta immediately and flushes buffered deltas at completion', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const model: ModelGateway = {
      async *stream() {
        yield { type: 'output.delta', delta: 'first' };
        await gate;
        yield { type: 'output.delta', delta: '-' };
        yield { type: 'output.delta', delta: 'last' };
        yield { type: 'completed', result: { output: 'first-last' } };
      },
    };
    const stream = readModelStream(model, input());

    await expect(stream.next()).resolves.toEqual({ done: false, value: 'first' });
    finish();
    await expect(stream.next()).resolves.toEqual({ done: false, value: '-last' });
    await expect(stream.next()).resolves.toEqual({
      done: true,
      value: { output: 'first-last' },
    });
  });

  test('splits large fragments by Unicode character without breaking code points', async () => {
    const output = '🦊'.repeat(513);
    const model: ModelGateway = {
      async *stream() {
        yield { type: 'output.delta', delta: output };
        yield { type: 'completed', result: { output } };
      },
    };

    const collected = await collect(model);
    expect(collected.deltas.map((delta) => Array.from(delta).length)).toEqual([512, 1]);
    expect(collected.deltas.join('')).toBe(output);
  });

  test('flushes buffered output on the latency limit', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const model: ModelGateway = {
      async *stream() {
        yield { type: 'output.delta', delta: 'first' };
        yield { type: 'output.delta', delta: '-timed' };
        await gate;
        yield { type: 'completed', result: { output: 'first-timed' } };
      },
    };
    const stream = readModelStream(model, input());

    await stream.next();
    const startedAt = performance.now();
    await expect(stream.next()).resolves.toEqual({ done: false, value: '-timed' });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(20);
    finish();
    await expect(stream.next()).resolves.toEqual({
      done: true,
      value: { output: 'first-timed' },
    });
  });

  test('accepts equivalent fragmented JSON and rejects inconsistent output', async () => {
    const valid: ModelGateway = {
      async *stream() {
        yield { type: 'output.delta', delta: '{"answer":' };
        yield { type: 'output.delta', delta: '"ok"}' };
        yield { type: 'completed', result: { output: { answer: 'ok' } } };
      },
    };
    await expect(collect(valid)).resolves.toMatchObject({
      result: { output: { answer: 'ok' } },
    });

    const invalid: ModelGateway = {
      async *stream() {
        yield { type: 'output.delta', delta: 'visible' };
        yield { type: 'completed', result: { output: 'different' } };
      },
    };
    await expect(collect(invalid)).rejects.toThrow(
      'Model stream deltas do not match the final output',
    );
  });

  test('rejects missing, duplicate and post-terminal events', async () => {
    const cases: Array<[ModelGateway, string]> = [
      [
        {
          async *stream() {
            yield { type: 'output.delta' as const, delta: 'partial' };
          },
        },
        'ModelGateway stream ended without completed',
      ],
      [
        {
          async *stream() {
            yield { type: 'completed' as const, result: { output: '' } };
            yield { type: 'completed' as const, result: { output: '' } };
          },
        },
        'ModelGateway stream emitted an event after completed',
      ],
      [
        {
          async *stream() {
            yield { type: 'completed' as const, result: { output: '' } };
            yield { type: 'output.delta' as const, delta: 'late' };
          },
        },
        'ModelGateway stream emitted an event after completed',
      ],
    ];

    for (const [model, message] of cases) {
      await expect(collect(model)).rejects.toThrow(message);
    }
  });

  test('flushes partial output before preserving the original gateway error', async () => {
    const providerError = new Error('provider failed');
    const model: ModelGateway = {
      async *stream() {
        yield { type: 'output.delta', delta: 'first' };
        yield { type: 'output.delta', delta: '-buffered' };
        throw providerError;
      },
    };
    const stream = readModelStream(model, input());

    await expect(stream.next()).resolves.toEqual({ done: false, value: 'first' });
    await expect(stream.next()).resolves.toEqual({ done: false, value: '-buffered' });
    await expect(stream.next()).rejects.toBe(providerError);
  });

  test('requests iterator closure when aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    let closed = false;
    const model: ModelGateway = {
      async *stream(modelInput) {
        try {
          yield { type: 'output.delta', delta: 'first' };
          await new Promise<void>((_resolve, reject) => {
            modelInput.signal?.addEventListener('abort', () => reject(modelInput.signal?.reason), {
              once: true,
            });
          });
        } finally {
          closed = true;
        }
      },
    };
    const stream = readModelStream(model, input(controller.signal));

    await stream.next();
    const pending = stream.next();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await Promise.resolve();
    expect(closed).toBe(true);
  });
});
