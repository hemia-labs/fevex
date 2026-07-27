import type { ModelGateway, ModelInput, ModelResult, ModelStreamEvent } from '../models';
import { abortable } from './run-support';

const MAX_DELTA_CHARS = 512;
const MAX_DELTA_DELAY_MS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

function assertConsistentOutput(result: ModelResult, outputText: string): void {
  if (result.output === undefined) {
    if (outputText) throw new TypeError('Model stream emitted output without a final output');
    return;
  }
  if (typeof result.output === 'string') {
    if (result.output !== outputText) {
      throw new TypeError('Model stream deltas do not match the final output');
    }
    return;
  }
  if (!outputText) {
    throw new TypeError('Model stream returned JSON output without output deltas');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    throw new TypeError('Model stream output deltas are not valid JSON', { cause: error });
  }
  if (JSON.stringify(canonicalJson(parsed)) !== JSON.stringify(canonicalJson(result.output))) {
    throw new TypeError('Model stream deltas do not match the final JSON output');
  }
}

function assertStreamEvent(value: unknown): asserts value is ModelStreamEvent {
  if (!isRecord(value)) throw new TypeError('ModelGateway stream event must be an object');
  if (value.type === 'output.delta') {
    if (typeof value.delta !== 'string') {
      throw new TypeError('ModelGateway output.delta must contain a string delta');
    }
    return;
  }
  if (value.type === 'completed') {
    if (!isRecord(value.result)) {
      throw new TypeError('ModelGateway completed event must contain a result');
    }
    return;
  }
  throw new TypeError('ModelGateway returned an unknown stream event');
}

function takeCharacters(value: string, count: number): [string, string] {
  const characters = Array.from(value);
  return [characters.slice(0, count).join(''), characters.slice(count).join('')];
}

export async function* readModelStream(
  model: ModelGateway,
  input: ModelInput,
): AsyncGenerator<string, ModelResult> {
  input.signal?.throwIfAborted();
  const stream = model.stream(input);
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('ModelGateway.stream must return an AsyncIterable');
  }

  const iterator = stream[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<ModelStreamEvent>> | undefined;
  let completed: ModelResult | undefined;
  let outputText = '';
  let buffer = '';
  let firstDelta = true;
  let bufferedAt = 0;

  const next = (): Promise<IteratorResult<ModelStreamEvent>> => {
    const promise = abortable(() => iterator.next(), input.signal);
    void promise.catch(() => {});
    return promise;
  };

  try {
    while (true) {
      if (buffer && Array.from(buffer).length >= MAX_DELTA_CHARS) {
        const [chunk, rest] = takeCharacters(buffer, MAX_DELTA_CHARS);
        buffer = rest;
        bufferedAt = performance.now();
        yield chunk;
        continue;
      }

      pending ??= next();
      let item: IteratorResult<ModelStreamEvent>;
      if (buffer) {
        const remaining = Math.max(0, MAX_DELTA_DELAY_MS - (performance.now() - bufferedAt));
        const raced = await Promise.race([
          pending.then((value) => ({ type: 'item' as const, value })),
          new Promise<{ type: 'flush' }>((resolve) => {
            setTimeout(() => resolve({ type: 'flush' }), remaining);
          }),
        ]);
        if (raced.type === 'flush') {
          const chunk = buffer;
          buffer = '';
          bufferedAt = 0;
          yield chunk;
          continue;
        }
        item = raced.value;
      } else {
        item = await pending;
      }
      pending = undefined;

      if (item.done) {
        if (!completed) throw new TypeError('ModelGateway stream ended without completed');
        assertConsistentOutput(completed, outputText);
        return completed;
      }

      assertStreamEvent(item.value);
      if (completed) {
        throw new TypeError('ModelGateway stream emitted an event after completed');
      }
      if (item.value.type === 'completed') {
        completed = item.value.result;
        if (buffer) {
          const chunk = buffer;
          buffer = '';
          bufferedAt = 0;
          yield chunk;
        }
        continue;
      }
      if (!item.value.delta) continue;

      outputText += item.value.delta;
      buffer += item.value.delta;
      if (firstDelta) {
        const [chunk, rest] = takeCharacters(buffer, MAX_DELTA_CHARS);
        firstDelta = false;
        buffer = rest;
        bufferedAt = performance.now();
        yield chunk;
      } else if (!bufferedAt) {
        bufferedAt = performance.now();
      }
    }
  } catch (error) {
    if (buffer) yield buffer;
    throw error;
  } finally {
    if (pending) void pending.catch(() => {});
    if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
  }
}
