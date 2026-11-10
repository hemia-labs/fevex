import {
  handleChannelInput,
  type ChannelAdapter,
  type ChannelContext,
  type ChannelElicitationContext,
  type ChannelMessage,
  type ChannelOutput,
  type ChannelRunOptions,
  type ChannelRunResult,
} from '@fevex/core/channels';
import type { ElicitationRequest } from '@fevex/core/runtime';

export type SlackHeaders = Headers | Record<string, string | undefined>;
export type SlackFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SlackWebhookRequest {
  headers: SlackHeaders;
  body: string;
}

export interface SlackDelivery {
  channel: string;
  ts: string;
}

/**
 * Durable state is the host's responsibility. The in-memory implementation
 * deduplicates one process; use a shared store for multiple workers.
 */
export interface SlackStore {
  claimEvent(eventId: string): boolean | Promise<boolean>;
  getDelivery(deliveryId: string): SlackDelivery | undefined | Promise<SlackDelivery | undefined>;
  saveDelivery(deliveryId: string, delivery: SlackDelivery): void | Promise<void>;
}

export interface SlackClient {
  postMessage(input: {
    channel: string;
    text: string;
    threadTs?: string;
    signal?: AbortSignal;
  }): Promise<SlackDelivery>;
}

export type SlackErrorCode =
  | 'SLACK_INVALID_SIGNATURE'
  | 'SLACK_INVALID_PAYLOAD'
  | 'SLACK_API_ERROR'
  | 'SLACK_RATE_LIMITED'
  | 'SLACK_MISSING_TOKEN';

export class SlackError extends Error {
  readonly name = 'SlackError';

  constructor(readonly code: SlackErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface SlackSignatureOptions {
  signingSecret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  body: string;
  /** Milliseconds since the epoch. Defaults to Date.now(). */
  now?: number;
  /** Defaults to 300 seconds, matching Slack's replay window. */
  toleranceSeconds?: number;
}

export async function verifySlackSignature(options: SlackSignatureOptions): Promise<boolean> {
  if (!options.signingSecret || !options.timestamp || !options.signature || !options.body) return false;
  const timestamp = Number(options.timestamp);
  if (!Number.isSafeInteger(timestamp)) return false;
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance <= 0) return false;
  const now = options.now ?? Date.now();
  if (Math.abs(now / 1000 - timestamp) > tolerance) return false;
  if (!options.signature.startsWith('v0=')) return false;
  const expected = await hmacHex(options.signingSecret, `v0:${options.timestamp}:${options.body}`);
  return timingSafeEqual(expected, options.signature.slice(3));
}

export interface SlackRequestVerificationOptions {
  signingSecret: string;
  now?: number;
  toleranceSeconds?: number;
}

export async function verifySlackRequest(
  request: SlackWebhookRequest,
  options: SlackRequestVerificationOptions,
): Promise<boolean> {
  return verifySlackSignature({
    signingSecret: options.signingSecret,
    timestamp: getHeader(request.headers, 'x-slack-request-timestamp'),
    signature: getHeader(request.headers, 'x-slack-signature'),
    body: request.body,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.toleranceSeconds === undefined ? {} : { toleranceSeconds: options.toleranceSeconds }),
  });
}

export interface SlackClientOptions {
  botToken?: string;
  fetch?: SlackFetch;
  /** Defaults to https://slack.com/api/chat.postMessage. */
  apiUrl?: string;
}

export function createSlackClient(options: SlackClientOptions): SlackClient {
  const fetchImpl = options.fetch ?? fetch;
  const apiUrl = options.apiUrl ?? 'https://slack.com/api/chat.postMessage';
  return {
    async postMessage({ channel, text, threadTs, signal }) {
      if (!options.botToken) {
        throw new SlackError('SLACK_MISSING_TOKEN', 'Slack botToken is required to post messages');
      }
      const response = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
        ...(signal ? { signal } : {}),
      });
      const payload = await response.json().catch(() => undefined) as SlackApiResponse | undefined;
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new SlackError(
          'SLACK_RATE_LIMITED',
          `Slack rate limit exceeded${retryAfter ? `; retry after ${retryAfter}s` : ''}`,
        );
      }
      if (!response.ok || payload?.ok !== true) {
        throw new SlackError(
          'SLACK_API_ERROR',
          `Slack chat.postMessage failed: ${payload?.error ?? `HTTP ${response.status}`}`,
        );
      }
      if (typeof payload.channel !== 'string' || typeof payload.ts !== 'string') {
        throw new SlackError('SLACK_API_ERROR', 'Slack chat.postMessage returned no channel or ts');
      }
      return { channel: payload.channel, ts: payload.ts };
    },
  };
}

export interface InMemorySlackStoreOptions {
  /** Defaults to 24 hours. */
  ttlMs?: number;
  /** Defaults to 10,000 entries. */
  maxEntries?: number;
  now?: () => number;
}

// ponytail: per-process store; pass a shared SlackStore for multi-worker deployments.
/** Per-process dedupe store. Pass a shared SlackStore for multi-worker deployments. */
export function createInMemorySlackStore(options: InMemorySlackStoreOptions = {}): SlackStore {
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError('Slack store ttlMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError('Slack store maxEntries must be a positive safe integer');
  }
  const events = new Map<string, number>();
  const deliveries = new Map<string, { expiresAt: number; delivery: SlackDelivery }>();
  const prune = <T>(map: Map<string, T>, expiresAt: (value: T) => number) => {
    const at = now();
    for (const [key, value] of map) {
      if (expiresAt(value) <= at) map.delete(key);
    }
    while (map.size >= maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  };
  return {
    claimEvent(eventId) {
      prune(events, (expiresAt) => expiresAt);
      if (events.has(eventId)) return false;
      events.set(eventId, now() + ttlMs);
      return true;
    },
    getDelivery(deliveryId) {
      prune(deliveries, (entry) => entry.expiresAt);
      return deliveries.get(deliveryId)?.delivery;
    },
    saveDelivery(deliveryId, delivery) {
      prune(deliveries, (entry) => entry.expiresAt);
      deliveries.set(deliveryId, { expiresAt: now() + ttlMs, delivery });
    },
  };
}

export interface SlackAdapterOptions extends SlackRequestVerificationOptions {
  botToken?: string;
  client?: SlackClient;
  store?: SlackStore;
  botUserId?: string;
  /** Accept channel messages that do not mention the bot. Defaults to false. */
  allowChannelMessages?: boolean;
  fetch?: SlackFetch;
  apiUrl?: string;
}

export interface SlackAdapter extends ChannelAdapter<SlackWebhookRequest, SlackDelivery> {
  readonly name: 'slack';
  readonly store: SlackStore;
  verify(request: SlackWebhookRequest): Promise<boolean>;
}

export function createSlackAdapter(options: SlackAdapterOptions): SlackAdapter {
  if (!options.signingSecret) throw new TypeError('Slack signingSecret is required');
  if (options.toleranceSeconds !== undefined
    && (!Number.isFinite(options.toleranceSeconds) || options.toleranceSeconds <= 0)) {
    throw new TypeError('Slack toleranceSeconds must be a positive number');
  }
  const client = options.client ?? createSlackClient(options);
  const store = options.store ?? createInMemorySlackStore();
  const pending = new Map<string, Promise<SlackDelivery>>();

  async function verify(request: SlackWebhookRequest): Promise<boolean> {
    return verifySlackRequest(request, {
      signingSecret: options.signingSecret,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.toleranceSeconds === undefined ? {} : { toleranceSeconds: options.toleranceSeconds }),
    });
  }

  async function deliver(output: ChannelOutput, context: ChannelContext): Promise<SlackDelivery> {
    const existing = pending.get(output.deliveryId);
    if (existing) return existing;
    const promise = (async () => {
      const cached = await store.getDelivery(output.deliveryId);
      if (cached) return cached;
      const delivery = await client.postMessage({
        channel: output.conversationId,
        text: output.content,
        ...(output.threadId ? { threadTs: output.threadId } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      await store.saveDelivery(output.deliveryId, delivery);
      return delivery;
    })();
    pending.set(output.deliveryId, promise);
    try {
      return await promise;
    } finally {
      pending.delete(output.deliveryId);
    }
  }

  async function deliverElicitation(
    request: ElicitationRequest,
    context: ChannelElicitationContext,
  ): Promise<SlackDelivery> {
    return deliver({
      deliveryId: context.deliveryId,
      conversationId: context.conversationId,
      ...(context.threadId ? { threadId: context.threadId } : {}),
      content: elicitationText(request),
      metadata: { runId: context.runId, requestId: request.id },
    }, context);
  }

  async function parse(input: SlackWebhookRequest): Promise<ChannelMessage | null> {
    if (!(await verify(input))) {
      throw new SlackError('SLACK_INVALID_SIGNATURE', 'Invalid Slack request signature');
    }
    const envelope = parseJson(input.body);
    return parseEnvelope(envelope, options);
  }

  return { name: 'slack', store, verify, parse, deliver, deliverElicitation };
}

export interface SlackWebhookOptions extends Omit<ChannelRunOptions<SlackWebhookRequest, SlackDelivery>, 'adapter'> {
  adapter: SlackAdapter;
  onError?: (error: unknown, eventId: string) => void;
}

export interface SlackWebhookResponse {
  status: 200 | 400 | 401;
  body: string;
  /** Present after the webhook was accepted; acknowledge first and observe this separately. */
  done?: Promise<ChannelRunResult<SlackDelivery>>;
}

/**
 * Verifies the request, answers Slack challenges, deduplicates retries, and
 * starts processing without waiting for the agent. Acknowledge with `status`
 * and `body`, then observe `done`.
 */
export async function handleSlackWebhook(
  request: SlackWebhookRequest,
  options: SlackWebhookOptions,
): Promise<SlackWebhookResponse> {
  if (!(await options.adapter.verify(request))) {
    return { status: 401, body: 'invalid signature' };
  }
  let envelope: SlackEventEnvelope;
  try {
    envelope = JSON.parse(request.body) as SlackEventEnvelope;
  } catch {
    return { status: 400, body: 'invalid payload' };
  }
  if (envelope?.type === 'url_verification') {
    return typeof envelope.challenge === 'string'
      ? { status: 200, body: JSON.stringify({ challenge: envelope.challenge }) }
      : { status: 400, body: 'invalid payload' };
  }
  if (envelope?.type !== 'event_callback' || typeof envelope.event_id !== 'string') {
    return { status: 200, body: '' };
  }
  if (!(await options.adapter.store.claimEvent(`slack:${envelope.event_id}`))) {
    return { status: 200, body: '' };
  }
  const done = handleChannelInput(request, options);
  void done.catch((error) => {
    try {
      options.onError?.(error, envelope.event_id!);
    } catch {
      // An observer must not turn an accepted webhook into an unhandled rejection.
    }
  });
  return { status: 200, body: '', done };
}

interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: SlackEvent;
}

interface SlackEvent {
  type?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  channel?: string;
  ts?: string;
}

function parseJson(body: string): SlackEventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (cause) {
    throw new SlackError('SLACK_INVALID_PAYLOAD', 'Slack payload is not valid JSON', { cause });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SlackError('SLACK_INVALID_PAYLOAD', 'Slack payload must be a JSON object');
  }
  return value as SlackEventEnvelope;
}

function parseEnvelope(
  envelope: SlackEventEnvelope,
  options: { botUserId?: string; allowChannelMessages?: boolean },
): ChannelMessage | null {
  if (envelope.type !== 'event_callback' || typeof envelope.event_id !== 'string') return null;
  const event = envelope.event;
  if (!event || (event.type !== 'app_mention' && event.type !== 'message')) return null;
  if (event.bot_id || event.subtype || !event.user || typeof event.text !== 'string') return null;
  if (event.type === 'message' && event.channel_type !== 'im' && !options.allowChannelMessages) return null;
  if (typeof event.channel !== 'string' || typeof event.ts !== 'string') return null;
  const content = stripMention(event.text, options.botUserId).trim();
  if (!content) return null;
  const threadId = event.channel_type === 'im' ? event.thread_ts : event.thread_ts ?? event.ts;
  return {
    id: envelope.event_id,
    deliveryId: `slack:${envelope.event_id}`,
    conversationId: event.channel,
    ...(threadId ? { threadId } : {}),
    content,
    actor: { id: event.user, type: 'user' },
    metadata: {
      ...(envelope.team_id ? { teamId: envelope.team_id } : {}),
      ...(event.channel_type ? { channelType: event.channel_type } : {}),
      eventType: event.type,
      eventTs: event.ts,
    },
  };
}

function stripMention(text: string, botUserId?: string): string {
  if (!botUserId) return text;
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`<@${escaped}(?:\\|[^>]+)?>`, 'g'), ' ');
}

function elicitationText(request: ElicitationRequest): string {
  return `${request.prompt}\n\nReply in this thread with a JSON object matching this schema:\n\`\`\`json\n${JSON.stringify(request.responseSchema, null, 2)}\n\`\`\``;
}

function getHeader(headers: SlackHeaders, name: string): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value ?? undefined;
  }
  return undefined;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
