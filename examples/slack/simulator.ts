import { createHmac } from 'node:crypto';
import type { Fevex } from '@fevex/core';
import type { ChannelMessage, ChannelRunResult } from '@fevex/core/channels';
import {
  handleSlackWebhook,
  type SlackAdapter,
  type SlackDelivery,
  type SlackWebhookOptions,
  type SlackWebhookResponse,
} from '@fevex/slack';

export type SimulatedRun = Extract<ChannelRunResult<SlackDelivery>, { ignored: false }>;

export interface SimulatedTool {
  name: string;
  status: 'completed' | 'failed';
}

export interface SimulatedMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: string;
  threadId: string;
  tools?: SimulatedTool[];
}

export interface SimulatedMessageStore {
  push(conversationId: string, message: SimulatedMessage): void;
  list(conversationId: string): SimulatedMessage[];
}

export function createSimulatedMessageStore(): SimulatedMessageStore {
  const messages = new Map<string, SimulatedMessage[]>();
  return {
    push(conversationId, message) {
      const current = messages.get(conversationId) ?? [];
      current.push(message);
      messages.set(conversationId, current);
    },
    list(conversationId) {
      return messages.get(conversationId) ?? [];
    },
  };
}

export interface SlackSimulatorOptions {
  secret: string;
  fevex: Fevex;
  adapter: SlackAdapter;
  agentName: string;
  resolveSessionId: (message: ChannelMessage) => string | undefined | Promise<string | undefined>;
  onRun?: (run: SimulatedRun) => void | Promise<void>;
  messages?: SimulatedMessageStore;
}

interface SimulatePayload {
  text?: unknown;
  conversationId?: unknown;
  threadId?: unknown;
}

interface FakeSlackPayload {
  channel?: unknown;
  text?: unknown;
  thread_ts?: unknown;
}

/**
 * Local Slack substitute for the visual example. It signs Events API payloads
 * and captures chat.postMessage calls; it is not a Slack API implementation.
 */
export function createSlackSimulator(options: SlackSimulatorOptions) {
  const messages = options.messages ?? createSimulatedMessageStore();
  let sequence = 0;

  const nextTs = (): string => {
    sequence += 1;
    return `${Math.floor(Date.now() / 1000)}.${String(sequence).padStart(6, '0')}`;
  };
  const json = (value: unknown, status = 200): Response => Response.json(value, { status });
  const failure = (error: unknown): Response => {
    const cause = (error as { cause?: unknown }).cause;
    console.error(
      'Simulated Slack failure',
      error instanceof Error ? error.message : error,
      cause instanceof Error ? cause.message : '',
    );
    return json({
      error: error instanceof Error ? error.message : 'Simulated Slack request failed',
    }, 500);
  };

  const webhookOptions: SlackWebhookOptions = {
    fevex: options.fevex,
    adapter: options.adapter,
    agentName: options.agentName,
    resolveSessionId: options.resolveSessionId,
  };

  return {
    async handleFakeApi(request: Request): Promise<Response | undefined> {
      const path = new URL(request.url).pathname;
      if (path !== '/slack-api/chat.postMessage') return undefined;
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
      const body = await request.json().catch(() => undefined) as FakeSlackPayload | undefined;
      if (!body || typeof body.channel !== 'string' || typeof body.text !== 'string') {
        return json({ ok: false, error: 'invalid_arguments' }, 400);
      }
      const ts = nextTs();
      const threadId = typeof body.thread_ts === 'string' ? body.thread_ts : ts;
      messages.push(body.channel, {
        id: `assistant-${ts}`,
        role: 'assistant',
        text: body.text,
        ts,
        threadId,
      });
      return json({ ok: true, channel: body.channel, ts });
    },

    async handleSimulate(request: Request): Promise<Response> {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const body = await request.json().catch(() => undefined) as SimulatePayload | undefined;
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) return json({ error: 'Message text is required' }, 400);
      if (text.length > 4_000) return json({ error: 'Message is too long' }, 400);
      const conversationId = typeof body?.conversationId === 'string' && body.conversationId.trim()
        ? body.conversationId
        : `sim-${crypto.randomUUID()}`;
      const previousThread = typeof body?.threadId === 'string' && body.threadId.trim()
        ? body.threadId
        : undefined;
      const eventTs = nextTs();
      const threadId = previousThread ?? eventTs;
      const payload = {
        type: 'event_callback',
        team_id: 'T-SIM',
        event_id: `Ev-${crypto.randomUUID()}`,
        event: {
          type: 'app_mention',
          channel: conversationId,
          channel_type: 'channel',
          user: 'U-SIM',
          text: `<@UBOT> ${text}`,
          ts: eventTs,
          ...(previousThread ? { thread_ts: previousThread } : {}),
        },
      };
      const serialized = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac('sha256', options.secret)
        .update(`v0:${timestamp}:${serialized}`)
        .digest('hex')}`;

      messages.push(conversationId, {
        id: `user-${eventTs}`,
        role: 'user',
        text,
        ts: eventTs,
        threadId,
      });

      let result: SlackWebhookResponse;
      try {
        result = await handleSlackWebhook(
          {
            body: serialized,
            headers: {
              'x-slack-request-timestamp': timestamp,
              'x-slack-signature': signature,
            },
          },
          webhookOptions,
        );
      } catch (error) {
        return failure(error);
      }
      if (!result.done) return json({ error: 'Slack event was not accepted' }, 400);

      let run: ChannelRunResult<SlackDelivery>;
      try {
        run = await result.done;
      } catch (error) {
        return failure(error);
      }
      if (run.ignored) return json({ error: 'Slack event was ignored' }, 400);
      const assistant = [...messages.list(conversationId)]
        .reverse()
        .find((message) => message.role === 'assistant' && message.threadId === threadId);
      if (assistant) {
        assistant.tools = run.events.flatMap((event) => {
          if (event.type !== 'tool.completed' && event.type !== 'tool.failed') return [];
          return [{
            name: event.payload.toolName,
            status: event.type === 'tool.completed' ? 'completed' as const : 'failed' as const,
          }];
        });
      }
      await options.onRun?.(run);
      return json({ threadId, messages: messages.list(conversationId) });
    },
  };
}
