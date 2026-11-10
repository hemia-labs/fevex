import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createFevex, defineAgent } from '@fevex/core';
import { fakeModel, testChannelAdapter, type ChannelAdapterContract } from '@fevex/core/testing';
import type { ChannelElicitationContext, ChannelOutput } from '@fevex/core/channels';
import type { ElicitationRequest } from '@fevex/core/runtime';
import {
  SlackError,
  createInMemorySlackStore,
  createSlackAdapter,
  createSlackClient,
  handleSlackWebhook,
  verifySlackSignature,
  type SlackClient,
  type SlackDelivery,
  type SlackWebhookRequest,
} from './index';

const signingSecret = 'test-signing-secret';
const fixedNow = 1_800_000_000_000;
const timestamp = String(fixedNow / 1000);

function signature(secret: string, body: string, ts = timestamp): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function request(
  payload: unknown,
  options: { secret?: string; timestamp?: string; body?: string } = {},
): SlackWebhookRequest {
  const body = options.body ?? JSON.stringify(payload);
  const ts = options.timestamp ?? timestamp;
  return {
    body,
    headers: {
      'X-Slack-Request-Timestamp': ts,
      'X-Slack-Signature': signature(options.secret ?? signingSecret, body, ts),
    },
  };
}

function eventPayload(
  event: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev1',
    event: {
      type: 'app_mention',
      channel: 'C1',
      channel_type: 'channel',
      user: 'U1',
      text: '<@B1> hello',
      ts: '1700000000.000100',
      ...event,
    },
    ...envelope,
  };
}

function fakeClient(receipt: SlackDelivery = { channel: 'C1', ts: '1700000000.000200' }) {
  const calls: Array<Parameters<SlackClient['postMessage']>[0]> = [];
  return {
    calls,
    async postMessage(input: Parameters<SlackClient['postMessage']>[0]) {
      calls.push(input);
      return { ...receipt, channel: input.channel };
    },
  };
}

function testAdapter() {
  const client = fakeClient();
  const store = createInMemorySlackStore({ now: () => fixedNow });
  const adapter = createSlackAdapter({
    signingSecret,
    botUserId: 'B1',
    now: fixedNow,
    client,
    store,
  });
  return { adapter, client, store };
}

describe('Slack request signatures', () => {
  test('accepts a fresh v0 signature and rejects tampering, wrong secrets and stale timestamps', async () => {
    const body = JSON.stringify(eventPayload());
    const valid = {
      signingSecret,
      body,
      timestamp,
      signature: signature(signingSecret, body),
      now: fixedNow,
    };
    expect(await verifySlackSignature(valid)).toBe(true);
    expect(await verifySlackSignature({ ...valid, body: `${body} ` })).toBe(false);
    expect(await verifySlackSignature({ ...valid, signature: signature('wrong', body) })).toBe(false);
    expect(await verifySlackSignature({ ...valid, now: fixedNow + 400_000 })).toBe(false);
    expect(await verifySlackSignature({ ...valid, timestamp: 'not-a-number' })).toBe(false);
    expect(await verifySlackSignature({ ...valid, signature: 'v1=abc' })).toBe(false);
  });
});

describe('Slack adapter', () => {
  test('maps mentions and DMs to ChannelMessage values', async () => {
    const { adapter } = testAdapter();
    const mention = await adapter.parse(request(eventPayload()), {});
    expect(mention).toEqual({
      id: 'Ev1',
      deliveryId: 'slack:Ev1',
      conversationId: 'C1',
      threadId: '1700000000.000100',
      content: 'hello',
      actor: { id: 'U1', type: 'user' },
      metadata: {
        teamId: 'T1',
        channelType: 'channel',
        eventType: 'app_mention',
        eventTs: '1700000000.000100',
      },
    });

    const dm = await adapter.parse(request(eventPayload({
      type: 'message',
      channel: 'D1',
      channel_type: 'im',
      text: 'direct message',
    })), {});
    expect(dm).toMatchObject({ conversationId: 'D1', content: 'direct message' });
    expect(dm?.threadId).toBeUndefined();
  });

  test('ignores bots, edits, unrelated events and channel messages without a mention', async () => {
    const { adapter } = testAdapter();
    expect(await adapter.parse(request(eventPayload({ bot_id: 'B2' })), {})).toBeNull();
    expect(await adapter.parse(request(eventPayload({ subtype: 'message_changed' })), {})).toBeNull();
    expect(await adapter.parse(request({ type: 'event_callback', event_id: 'Ev2', event: { type: 'reaction_added' } }), {})).toBeNull();
    const ambient = request(eventPayload({
      type: 'message',
      channel_type: 'channel',
      text: 'ambient message',
    }));
    expect(await adapter.parse(ambient, {})).toBeNull();
    const permissive = createSlackAdapter({
      signingSecret,
      botUserId: 'B1',
      now: fixedNow,
      client: fakeClient(),
      allowChannelMessages: true,
    });
    expect((await permissive.parse(ambient, {}))?.content).toBe('ambient message');
    expect(await adapter.parse(request({ type: 'url_verification', challenge: 'abc' }), {})).toBeNull();
  });

  test('rejects invalid signatures before parsing', async () => {
    const { adapter } = testAdapter();
    await expect(adapter.parse(request(eventPayload(), { secret: 'wrong' }), {})).rejects.toMatchObject({
      code: 'SLACK_INVALID_SIGNATURE',
    });
    await expect(adapter.parse(request({}, { body: 'null' }), {})).rejects.toMatchObject({
      code: 'SLACK_INVALID_PAYLOAD',
    });
  });

  test('delivers once per delivery id and sends elicitation prompts', async () => {
    const { adapter, client } = testAdapter();
    const output: ChannelOutput = {
      deliveryId: 'slack:Ev1',
      conversationId: 'C1',
      threadId: '1700000000.000100',
      content: 'hello back',
    };
    const first = await adapter.deliver(output, {});
    const second = await adapter.deliver(output, {});
    expect(first).toEqual({ channel: 'C1', ts: '1700000000.000200' });
    expect(second).toEqual(first);
    expect(client.calls).toEqual([{
      channel: 'C1',
      text: 'hello back',
      threadTs: '1700000000.000100',
    }]);

    const elicitation: ElicitationRequest = {
      id: 'req-1',
      toolCallId: 'call-1',
      prompt: 'Which account?',
      responseSchema: {
        type: 'object',
        properties: { account: { type: 'string' } },
        required: ['account'],
        additionalProperties: false,
      },
      requestedAt: '2026-11-09T00:00:00.000Z',
    };
    const context: ChannelElicitationContext = {
      deliveryId: 'elicitation:run-1:req-1',
      runId: 'run-1',
      sessionId: 'session-1',
      conversationId: 'C1',
      threadId: '1700000000.000100',
    };
    expect(adapter.deliverElicitation).toBeDefined();
    const prompt = await adapter.deliverElicitation!(elicitation, context);
    const retry = await adapter.deliverElicitation!(elicitation, context);
    expect(retry).toEqual(prompt);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.text).toContain('Which account?');
    expect(client.calls[1]?.text).toContain('"account"');
  });

  test('passes the Slack adapter contract helper', async () => {
    const { adapter } = testAdapter();
    const input = request(eventPayload());
    const message = (await adapter.parse(input, {}))!;
    const output: ChannelOutput = {
      deliveryId: message.deliveryId,
      conversationId: message.conversationId,
      threadId: message.threadId!,
      content: message.content,
    };
    const contract: ChannelAdapterContract<SlackWebhookRequest, SlackDelivery> = {
      input,
      message,
      output,
      delivered: { channel: 'C1', ts: '1700000000.000200' },
      ignoredInput: request(eventPayload({ bot_id: 'B2' }, { event_id: 'Ev2' })),
      elicitation: {
        request: {
          id: 'req-1',
          toolCallId: 'call-1',
          prompt: 'Which account?',
          responseSchema: { type: 'object', properties: { account: { type: 'string' } } },
          requestedAt: '2026-11-09T00:00:00.000Z',
        },
        context: {
          deliveryId: 'elicitation:run-1:req-1',
          runId: 'run-1',
          sessionId: 'session-1',
          conversationId: 'C1',
          threadId: '1700000000.000100',
        },
        delivered: { channel: 'C1', ts: '1700000000.000200' },
      },
    };
    await testChannelAdapter(adapter, contract);
  });
});

describe('Slack Web API client', () => {
  test('posts JSON with a bearer token and returns the message receipt', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = createSlackClient({
      botToken: 'xoxb-test',
      fetch: async (url, init) => {
        captured = { url: String(url), init: init! };
        return Response.json({ ok: true, channel: 'C1', ts: '1700000000.000300' });
      },
    });
    const delivery = await client.postMessage({
      channel: 'C1',
      text: 'hello',
      threadTs: '1700000000.000100',
    });
    expect(delivery).toEqual({ channel: 'C1', ts: '1700000000.000300' });
    expect(captured?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(new Headers(captured?.init.headers).get('authorization')).toBe('Bearer xoxb-test');
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      channel: 'C1',
      text: 'hello',
      thread_ts: '1700000000.000100',
    });
  });

  test('maps Slack API errors and rate limits without leaking the token', async () => {
    const failed = createSlackClient({
      botToken: 'xoxb-secret',
      fetch: async () => Response.json({ ok: false, error: 'channel_not_found' }),
    });
    await expect(failed.postMessage({ channel: 'C1', text: 'hello' })).rejects.toMatchObject({
      code: 'SLACK_API_ERROR',
      message: 'Slack chat.postMessage failed: channel_not_found',
    });

    const limited = createSlackClient({
      botToken: 'xoxb-secret',
      fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    });
    await expect(limited.postMessage({ channel: 'C1', text: 'hello' })).rejects.toMatchObject({
      code: 'SLACK_RATE_LIMITED',
      message: 'Slack rate limit exceeded; retry after 30s',
    });
  });
});

describe('Slack webhook handler', () => {
  test('rejects invalid signatures without starting a run', async () => {
    const { adapter } = testAdapter();
    const model = fakeModel({ output: 'pong' });
    const app = createFevex({
      models: { test: model },
      agents: [defineAgent({ name: 'assistant', model: 'test', instructions: 'Reply.' })],
    });
    const result = await handleSlackWebhook(request(eventPayload(), { secret: 'wrong' }), {
      fevex: app,
      adapter,
      agentName: 'assistant',
    });
    expect(result).toEqual({ status: 401, body: 'invalid signature' });
    expect(model.calls).toHaveLength(0);
  });

  test('answers URL verification without starting a run', async () => {
    const { adapter } = testAdapter();
    const model = fakeModel({ output: 'pong' });
    const app = createFevex({
      models: { test: model },
      agents: [defineAgent({ name: 'assistant', model: 'test', instructions: 'Reply.' })],
    });
    const result = await handleSlackWebhook(request({ type: 'url_verification', challenge: 'abc' }), {
      fevex: app,
      adapter,
      agentName: 'assistant',
    });
    expect(result).toEqual({ status: 200, body: JSON.stringify({ challenge: 'abc' }) });
    expect(model.calls).toHaveLength(0);
  });

  test('runs once per event id and returns the same run shape as a local channel', async () => {
    const { adapter } = testAdapter();
    const model = fakeModel({ output: 'pong' });
    const app = createFevex({
      models: { test: model },
      agents: [defineAgent({ name: 'assistant', model: 'test', instructions: 'Reply.' })],
    });
    const sessions = new Map<string, string>();
    const options = {
      fevex: app,
      adapter,
      agentName: 'assistant',
      resolveSessionId: (message: { threadId?: string; conversationId: string }) =>
        sessions.get(message.threadId ?? message.conversationId),
    };
    const webhook = request(eventPayload());
    const first = await handleSlackWebhook(webhook, options);
    expect(first.status).toBe(200);
    const run = await first.done!;
    if (run.ignored) throw new Error('Expected a run');
    expect(run.run.agentName).toBe('assistant');
    expect(run.run.status).toBe('completed');
    expect(run.output.content).toBe('pong');
    expect(run.events.some((event) => event.type === 'channel.received')).toBe(true);
    expect(run.events.some((event) => event.type === 'run.completed')).toBe(true);
    sessions.set(run.message.threadId ?? run.message.conversationId, run.run.sessionId);

    const retry = await handleSlackWebhook(webhook, options);
    expect(retry).toEqual({ status: 200, body: '' });
    expect(model.calls).toHaveLength(1);
  });
});

describe('in-memory Slack store', () => {
  test('claims an event once and expires it', () => {
    let now = fixedNow;
    const store = createInMemorySlackStore({ ttlMs: 1_000, now: () => now });
    expect(store.claimEvent('Ev1')).toBe(true);
    expect(store.claimEvent('Ev1')).toBe(false);
    now += 1_001;
    expect(store.claimEvent('Ev1')).toBe(true);
  });
});

test('SlackError keeps a stable code', () => {
  expect(new SlackError('SLACK_INVALID_SIGNATURE', 'bad').code).toBe('SLACK_INVALID_SIGNATURE');
});
