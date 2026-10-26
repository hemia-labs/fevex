import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createFevex, defineAgent, type JsonValue } from '@fevex/core';
import { deliverChannelRun, handleChannelInput, type ChannelAdapter, type ChannelMessage, type ChannelOutput } from '@fevex/core/channels';
import { fakeModel } from '@fevex/core/testing';

/** A channel and an external resolver sharing the public resume API, without a server. */
export async function runDemo() {
  const ask = { toolCalls: [{ id: 'ask-account', name: 'fevex__elicit', input: {
    prompt: 'Which account should I use?',
    responseSchema: {
      type: 'object', properties: { account: { type: 'string' } },
      required: ['account'], additionalProperties: false,
    },
  } }] };
  const model = fakeModel(ask, { output: 'Human selected account-42.' }, ask, { output: 'Service selected account-99.' });
  const app = createFevex({
    models: { test: model },
    agents: [defineAgent({ name: 'assistant', model: 'test', instructions: 'Ask for an account.', elicitation: 'pause' })],
  });
  // Demo-only host state. Production uses durable, tenant-scoped routing and delivery records.
  const pending = new Map<string, { runId: string; requestId: string }>();
  const outbox = new Map<string, ChannelOutput>();
  const adapter: ChannelAdapter<ChannelMessage, string> = {
    name: 'memory',
    async parse(message) { return message; },
    async deliver(output) {
      // A real transport must accept this idempotency key or use a durable outbox.
      if (!outbox.has(output.deliveryId)) outbox.set(output.deliveryId, output);
      return output.deliveryId;
    },
    async deliverElicitation(request, context) {
      pending.set(context.conversationId, { runId: context.runId, requestId: request.id });
      return this.deliver({
        deliveryId: context.deliveryId, conversationId: context.conversationId,
        content: request.prompt, metadata: { runId: context.runId, requestId: request.id },
      }, context);
    },
  };
  const options = { fevex: app, adapter, agentName: 'assistant' };

  async function reply(conversationId: string, requestId: string, value: JsonValue, actor: { id: string; type: string }) {
    const route = pending.get(conversationId);
    assert(route && route.requestId === requestId, 'Reply does not match this conversation');
    // These actors are trusted fixtures. Production authenticates and authorizes them in the host.
    await app.resumeRun(route.runId, { type: 'elicitation', requestId, value, actor });
    pending.delete(conversationId);
  }

  async function finish(runId: string, message: ChannelMessage) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await app.getRun(runId);
      if (run?.status !== 'running') {
        assert.equal(run?.status, 'completed');
        return deliverChannelRun(runId, message, options);
      }
      await setTimeout(10);
    }
    throw new Error('Run did not finish');
  }

  const human = await handleChannelInput({ id: 'human-input', deliveryId: 'human-answer', conversationId: 'human-chat', content: 'Help me.' }, options);
  assert(!human.ignored && human.elicitation);
  await deliverChannelRun(human.run.id, human.message, options); // Retry the same request.
  assert.equal(outbox.size, 1);
  await reply('human-chat', human.elicitation.id, { account: 'account-42' }, { id: 'user-1', type: 'user' });
  const humanAnswer = await finish(human.run.id, human.message);
  await assert.rejects(() => reply('human-chat', human.elicitation!.id, { account: 'account-42' }, { id: 'user-1', type: 'user' }));

  const service = await handleChannelInput({ id: 'service-input', deliveryId: 'service-answer', conversationId: 'service-chat', content: 'Resolve automatically.' }, options);
  assert(!service.ignored && service.elicitation);
  // An external worker consumes committed events; onEvent is not a durable queue.
  for (const event of await app.listEvents(service.run.id)) {
    if (event.type === 'elicitation.requested') {
      await reply('service-chat', event.payload.request.id, { account: 'account-99' }, { id: 'account-service', type: 'service' });
    }
  }
  const serviceAnswer = await finish(service.run.id, service.message);
  assert.equal(outbox.size, 4);
  assert.equal(model.calls.length, 4);
  return { human: humanAnswer.output.content, service: serviceAnswer.output.content, deliveries: outbox.size, modelCalls: model.calls.length };
}

if (import.meta.main) console.log(JSON.stringify(await runDemo(), null, 2));
