import { describe, expect, test } from 'bun:test';
import type { ModelGateway, ModelInput, ModelResult, ModelStreamEvent } from '../models';
import { InMemoryRunStore } from '../runtime';
import { fakeModel, testModelGateway, testRunStore } from './index';

const input = (content: string, signal?: AbortSignal): ModelInput => ({
  messages: [{ role: 'user', content }],
  signal,
});

function* toModelEvents(result: ModelResult): Generator<ModelStreamEvent> {
  if (result.output !== undefined) {
    const delta = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    if (delta) yield { type: 'output.delta', delta };
  }
  yield { type: 'completed', result };
}

function streamFrom(
  generate: (input: ModelInput) => ModelResult | Promise<ModelResult>,
): ModelGateway['stream'] {
  return async function* (input) {
    yield* toModelEvents(await generate(input));
  };
}

async function collectModel(model: ModelGateway, modelInput: ModelInput): Promise<ModelResult> {
  let result: ModelResult | undefined;
  for await (const event of model.stream(modelInput)) {
    if (event.type === 'completed') result = event.result;
  }
  if (!result) throw new Error('Model stream did not complete');
  return result;
}

describe('RunStore contract', () => {
  test('passes for InMemoryRunStore', async () => {
    await expect(testRunStore(new InMemoryRunStore())).resolves.toBeUndefined();
  });
});

describe('fakeModel', () => {
  test('returns responses in order and records calls', async () => {
    const first = { output: 'first' };
    const second = { output: 'second' };
    const model = fakeModel(first, second);
    const firstInput = input('one');
    const secondInput = input('two');

    await expect(collectModel(model, firstInput)).resolves.toBe(first);
    await expect(collectModel(model, secondInput)).resolves.toBe(second);
    expect(model.calls).toEqual([firstInput, secondInput]);
  });

  test('does not consume or record an aborted call', async () => {
    const model = fakeModel({ output: 'ok' });
    const controller = new AbortController();
    controller.abort();

    await expect(collectModel(model, input('aborted', controller.signal))).rejects.toThrow();
    expect(model.calls).toHaveLength(0);
    await expect(collectModel(model, input('next'))).resolves.toEqual({ output: 'ok' });
  });

  test('fails when responses are exhausted', async () => {
    const model = fakeModel();

    await expect(collectModel(model, input('one'))).rejects.toThrow(
      'fakeModel has no response for call 1',
    );
    expect(model.calls).toHaveLength(1);
  });

  test('passes the shared ModelGateway contract', async () => {
    const model = fakeModel(
      { output: { answer: 'ok' }, usage: { totalTokens: 1 } },
      { toolCalls: [{ id: 'call-1', name: 'lookup', input: { query: 'value' } }] },
    );

    await expect(testModelGateway(model, { usage: true })).resolves.toBeUndefined();
  });

  test('ModelGateway contract preserves provider error identity', async () => {
    const providerError = new Error('provider failed');
    let calls = 0;

    await expect(
      testModelGateway(
        {
          stream: streamFrom(async (input) => {
            input.signal?.throwIfAborted();
            calls += 1;
            if (calls === 1) return { output: { answer: 'ok' } };
            if (calls === 2) {
              return { toolCalls: [{ id: 'call-1', name: 'lookup', input: { query: 'value' } }] };
            }
            throw providerError;
          }),
        },
        { error: providerError },
      ),
    ).resolves.toBeUndefined();
  });

  test('ModelGateway contract detects invalid gateways', async () => {
    await expect(
      testModelGateway({
        stream: streamFrom(async () => {
          return {};
        }),
      }),
    ).rejects.toThrow('ModelGateway must stream an output delta before completed');

    await expect(
      testModelGateway(fakeModel({ output: { answer: 'ok' } }, { output: 'not a tool call' })),
    ).rejects.toThrow('ModelGateway must return one tool call');
  });
});
