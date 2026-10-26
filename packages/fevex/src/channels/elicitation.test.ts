import { describe, expect, test } from 'bun:test';
import { createFevex, defineAgent } from '../index';
import { fakeModel, testChannelAdapter } from '../testing';
import type { ElicitationRequest } from '../runtime';
import {
  ChannelError,
  deliverChannelRun,
  handleChannelInput,
  type ChannelAdapter,
  type ChannelElicitationContext,
  type ChannelEvent,
  type ChannelOutput,
} from './index';

const responseSchema = {
  type: 'object',
  properties: { account: { type: 'string' } },
  required: ['account'],
  additionalProperties: false,
};

function fixture(expiresAt?: string) {
  const model = fakeModel(
    { toolCalls: [{ id: 'ask-account', name: 'fevex__elicit', input: {
      prompt: 'Which account?', responseSchema,
      ...(expiresAt ? { expiresAt } : {}),
    } }] },
    { output: 'Account selected.' },
  );
  const app = createFevex({
    models: { test: model },
    agents: [defineAgent({ name: 'assistant', model: 'test', instructions: 'Help.', elicitation: 'pause' })],
  });
  const outbox = new Map<string, ChannelOutput>();
  const contexts: ChannelElicitationContext[] = [];
  const adapter: ChannelAdapter<string, string> = {
    name: 'memory',
    async parse(content) {
      return { id: 'message-1', deliveryId: 'answer-1', conversationId: 'conversation-1', threadId: 'thread-1', content };
    },
    async deliver(output) {
      if (!outbox.has(output.deliveryId)) outbox.set(output.deliveryId, output);
      return output.deliveryId;
    },
    async deliverElicitation(request, context) {
      contexts.push(context);
      return this.deliver({
        deliveryId: context.deliveryId,
        conversationId: context.conversationId,
        threadId: context.threadId,
        content: request.prompt,
        metadata: { runId: context.runId, requestId: request.id },
      }, context);
    },
  };
  return { app, model, adapter, outbox, contexts, options: { fevex: app, adapter, agentName: 'assistant' } };
}

async function waitForCompletion(app: ReturnType<typeof createFevex>, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await app.getRun(runId);
    if (run?.status !== 'running') return run;
    await Bun.sleep(1);
  }
  throw new Error('Run did not settle');
}

describe('Channel elicitation', () => {
  test('delivers a correlated pause, resumes with the same API, and delivers the final answer', async () => {
    const { app, model, options, contexts, outbox } = fixture();
    const controller = new AbortController();
    const observed: ChannelEvent[] = [];
    const paused = await handleChannelInput('hello', {
      ...options, signal: controller.signal, onEvent: (event) => observed.push(event),
    });
    if (paused.ignored || !paused.elicitation) throw new Error('Expected an elicitation');
    expect(paused.run.status).toBe('paused');
    expect(paused.output.metadata).toMatchObject({ runId: paused.run.id, requestId: paused.elicitation.id });
    expect(contexts[0]).toMatchObject({
      runId: paused.run.id, sessionId: paused.run.sessionId,
      conversationId: 'conversation-1', threadId: 'thread-1', deliveryId: paused.output.deliveryId,
    });
    expect(contexts[0]?.signal).toBe(controller.signal);
    expect(paused.events.map((event) => event.type)).toContain('elicitation.requested');
    expect(observed.map((event) => event.type)).toEqual(['channel.received', 'channel.delivered']);
    expect(observed[1]).toMatchObject({ runId: paused.run.id, requestId: paused.elicitation.id });

    await expect(app.resumeRun(paused.run.id, {
      type: 'elicitation', requestId: paused.elicitation.id, value: {}, actor: { id: 'service-1', type: 'service' },
    })).rejects.toMatchObject({ code: 'ELICITATION_INVALID' });
    await expect(app.resumeRun(paused.run.id, {
      type: 'elicitation', requestId: 'wrong-request', value: { account: 'a-1' }, actor: { id: 'user-1' },
    })).rejects.toMatchObject({ code: 'ELICITATION_INVALID' });
    expect(model.calls).toHaveLength(1);

    const resolution = {
      type: 'elicitation' as const, requestId: paused.elicitation.id,
      value: { account: 'a-1' }, actor: { id: 'service-1', type: 'service' },
    };
    await app.resumeRun(paused.run.id, resolution);
    expect(await waitForCompletion(app, paused.run.id)).toMatchObject({ status: 'completed' });
    await expect(app.resumeRun(paused.run.id, resolution)).rejects.toMatchObject({ code: 'RUN_NOT_RESUMABLE' });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.messages.at(-1)?.content).toBe('{"account":"a-1"}');

    const completed = await deliverChannelRun(paused.run.id, paused.message, options);
    expect(completed.elicitation).toBeUndefined();
    expect(completed.output.content).toBe('Account selected.');
    expect(outbox.size).toBe(2);
    await deliverChannelRun(paused.run.id, paused.message, options);
    expect(outbox.size).toBe(2);
    expect(model.calls).toHaveLength(2);
  });

  test('retries an uncertain delivery with the same key, without another run or remote effect', async () => {
    const { app, model, adapter, options, contexts, outbox } = fixture();
    const original = adapter.deliverElicitation!.bind(adapter);
    let first = true;
    adapter.deliverElicitation = async (request, context) => {
      const receipt = await original(request, context);
      if (first) { first = false; throw new Error('secret transport details'); }
      return receipt;
    };
    let error!: ChannelError;
    const events: ChannelEvent[] = [];
    await handleChannelInput('hello', { ...options, onEvent: (event) => events.push(event) }).catch((cause) => { error = cause; });
    expect(error).toMatchObject({ code: 'CHANNEL_DELIVERY_FAILED', safeMessage: 'Channel delivery failed' });
    expect(events.at(-1)).toMatchObject({ type: 'channel.failed', phase: 'deliver', runId: error.runId });
    expect(JSON.stringify(events)).not.toContain('secret');
    const stored = await app.getRun(error.runId!);
    if (stored?.pause?.type !== 'elicitation') throw new Error('Expected an elicitation');
    expect(events.at(-1)).toMatchObject({ requestId: stored.pause.request.id });
    const message = (await adapter.parse('hello', {}))!;
    const retry = await deliverChannelRun(error.runId!, message, options);
    expect(retry.output.deliveryId).toBe(contexts[0]?.deliveryId);
    expect(contexts[1]?.deliveryId).toBe(contexts[0]?.deliveryId);
    expect(outbox.size).toBe(1);
    expect(model.calls).toHaveLength(1);
  });

  test('keeps the pause recoverable when a channel does not implement the hook', async () => {
    const { app, adapter, options } = fixture();
    delete adapter.deliverElicitation;
    let error!: ChannelError;
    await handleChannelInput('hello', options).catch((cause) => { error = cause; });
    expect(error).toMatchObject({ code: 'CHANNEL_ELICITATION_UNSUPPORTED' });
    expect((await app.getRun(error.runId!))?.pause?.type).toBe('elicitation');
  });

  test('preserves run correlation when the adapter throws a ChannelError', async () => {
    const { app, adapter, options } = fixture();
    adapter.deliverElicitation = async () => {
      throw new ChannelError('TRANSPORT_UNAVAILABLE', 'Transport unavailable');
    };
    let error!: ChannelError;
    await handleChannelInput('hello', options).catch((cause) => { error = cause; });
    expect(error).toMatchObject({ code: 'TRANSPORT_UNAVAILABLE', safeMessage: 'Transport unavailable' });
    expect(error.runId).toBeString();
    expect((await app.getRun(error.runId!))?.status).toBe('paused');
  });

  test('does not deliver an expired request or resume it', async () => {
    const { app, model, contexts, outbox, adapter, options } = fixture(new Date(0).toISOString());
    let error!: ChannelError;
    await handleChannelInput('hello', options).catch((cause) => { error = cause; });
    expect(error).toMatchObject({ code: 'CHANNEL_ELICITATION_EXPIRED' });
    const run = await app.getRun(error.runId!);
    if (run?.pause?.type !== 'elicitation') throw new Error('Expected an elicitation');
    await expect(deliverChannelRun(run.id, (await adapter.parse('hello', {}))!, options))
      .rejects.toMatchObject({ code: 'CHANNEL_ELICITATION_EXPIRED' });
    await expect(app.resumeRun(run.id, {
      type: 'elicitation', requestId: run.pause.request.id,
      value: { account: 'a-1' }, actor: { id: 'user-1' },
    })).rejects.toMatchObject({ code: 'ELICITATION_INVALID' });
    expect(contexts).toHaveLength(0);
    expect(outbox.size).toBe(0);
    expect(model.calls).toHaveLength(1);
  });

  test('does not deliver cancelled runs or aborted retries', async () => {
    const { app, contexts, options } = fixture();
    const paused = await handleChannelInput('hello', options);
    if (paused.ignored) throw new Error('Expected a run');
    const controller = new AbortController();
    controller.abort();
    await expect(deliverChannelRun(paused.run.id, paused.message, { ...options, signal: controller.signal })).rejects.toThrow();
    expect(contexts).toHaveLength(1);
    await app.cancelRun(paused.run.id);
    await expect(deliverChannelRun(paused.run.id, paused.message, options)).rejects.toMatchObject({ code: 'CHANNEL_RUN_FAILED' });
    expect(contexts).toHaveLength(1);
  });

  test('adapter contracts exercise elicitation redelivery and reject changed retry receipts', async () => {
    const { adapter, contexts } = fixture();
    const request: ElicitationRequest = { id: 'request-1', toolCallId: 'call-1', prompt: 'Which account?', responseSchema, requestedAt: new Date().toISOString() };
    const context: ChannelElicitationContext = { deliveryId: 'elicitation-1', runId: 'run-1', sessionId: 'session-1', conversationId: 'conversation-1' };
    const output = { deliveryId: 'answer-1', conversationId: 'conversation-1', content: 'ok' };
    const contract = {
      input: 'hello', message: (await adapter.parse('hello', {}))!, output, delivered: 'answer-1',
      elicitation: { request, context, delivered: 'elicitation-1' },
    };
    await testChannelAdapter(adapter, contract);
    expect(contexts).toHaveLength(2);
    let attempt = 0;
    await expect(testChannelAdapter({ ...adapter, async deliverElicitation() {
      return attempt++ === 0 ? 'elicitation-1' : 'duplicate-2';
    } }, contract)).rejects.toThrow('retry receipt');
  });
});
