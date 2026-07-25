import { describe, expect, test } from 'bun:test';
import type { ModelGenerateInput } from '../models';
import { fakeModel, testModelGateway } from './index';

const input = (content: string, signal?: AbortSignal): ModelGenerateInput => ({
  messages: [{ role: 'user', content }],
  signal,
});

describe('fakeModel', () => {
  test('returns responses in order and records calls', async () => {
    const first = { output: 'first' };
    const second = { output: 'second' };
    const model = fakeModel(first, second);
    const firstInput = input('one');
    const secondInput = input('two');

    await expect(model.generate(firstInput)).resolves.toBe(first);
    await expect(model.generate(secondInput)).resolves.toBe(second);
    expect(model.calls).toEqual([firstInput, secondInput]);
  });

  test('does not consume or record an aborted call', async () => {
    const model = fakeModel({ output: 'ok' });
    const controller = new AbortController();
    controller.abort();

    await expect(model.generate(input('aborted', controller.signal))).rejects.toThrow();
    expect(model.calls).toHaveLength(0);
    await expect(model.generate(input('next'))).resolves.toEqual({ output: 'ok' });
  });

  test('fails when responses are exhausted', async () => {
    const model = fakeModel();

    await expect(model.generate(input('one'))).rejects.toThrow(
      'fakeModel has no response for call 1',
    );
    expect(model.calls).toHaveLength(1);
  });

  test('passes the shared ModelGateway contract', async () => {
    const model = fakeModel(
      { output: 'ok', usage: { totalTokens: 1 } },
      { toolCalls: [{ id: 'call-1', name: 'lookup', input: { query: 'value' } }] },
    );

    await expect(testModelGateway(model, { usage: true })).resolves.toBeUndefined();
  });

  test('ModelGateway contract preserves provider error identity', async () => {
    const providerError = new Error('provider failed');
    let calls = 0;

    await expect(testModelGateway({
      async generate(input) {
        input.signal?.throwIfAborted();
        calls += 1;
        if (calls === 1) return { output: 'ok' };
        if (calls === 2) {
          return { toolCalls: [{ id: 'call-1', name: 'lookup', input: { query: 'value' } }] };
        }
        throw providerError;
      },
    }, { error: providerError })).resolves.toBeUndefined();
  });

  test('ModelGateway contract detects invalid gateways', async () => {
    await expect(testModelGateway({
      async generate() {
        return {};
      },
    })).rejects.toThrow('ModelGateway must return output for a final answer');

    await expect(testModelGateway(fakeModel(
      { output: 'ok' },
      { output: 'not a tool call' },
    ))).rejects.toThrow('ModelGateway must return one tool call');
  });
});
