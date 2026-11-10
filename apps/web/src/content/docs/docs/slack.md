---
title: Slack
description: Connect a Fevex agent to Slack mentions and direct messages.
---

`@fevex/slack` implements the `ChannelAdapter` contract for the Slack Events
API. It verifies request signatures, maps mentions and DMs to channel messages,
replies in threads and delivers elicitation prompts. The package is
repository-only; it is not published to npm by the release pipeline yet.

## Slack app

Create a Slack app and add the `app_mentions:read` and `chat:write` bot scopes.
For direct messages, add `im:history` and subscribe to `message.im`. Point the
Events API request URL at your handler, install the app in the workspace, and
set:

```bash
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=xoxb-...
SLACK_BOT_USER_ID=U...
```

Do not subscribe to both `app_mention` and `message.channels` for mentions;
Slack sends separate event ids and both would start a run. Subscribe to
`message.channels` only when the agent should answer ambient channel messages,
and enable `allowChannelMessages` in that case.

## Handler

```ts
import { createFevex } from '@fevex/core';
import { createInMemorySlackStore, createSlackAdapter, handleSlackWebhook } from '@fevex/slack';

const app = createFevex({ models, agents });
const adapter = createSlackAdapter({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  botToken: process.env.SLACK_BOT_TOKEN!,
  botUserId: process.env.SLACK_BOT_USER_ID,
  store: createInMemorySlackStore(),
});

// conversation/thread -> Fevex session. Use a durable store in production.
const sessions = new Map<string, string>();

const result = await handleSlackWebhook(
  { headers: request.headers, body: await request.text() },
  {
    fevex: app,
    adapter,
    agentName: 'support',
    // One session per Slack thread; one session per DM channel.
    resolveSessionId: (message) => sessions.get(message.threadId ?? message.conversationId),
  },
);

if (result.done) {
  void result.done.then((run) => {
    if (!run.ignored) {
      sessions.set(run.message.threadId ?? run.message.conversationId, run.run.sessionId);
    }
  }).catch(console.error);
}
return new Response(result.body, {
  status: result.status,
  headers: result.status === 200 && result.body ? { 'content-type': 'application/json' } : undefined,
});
```

Slack requires a 2xx response within three seconds. `handleSlackWebhook`
verifies the signature, answers `url_verification`, claims the event id and
returns before the agent finishes. Acknowledge, then observe `done` or enqueue
it. Waiting for the agent before acknowledging causes Slack retries. In
serverless hosts, enqueue before responding so the runtime is not frozen after
the acknowledgment. Do not pass the webhook request's `AbortSignal` as the run
signal if it aborts when the response ends.

Pass the raw request body. Parsing JSON first and re-serializing it changes the
bytes and invalidates the signature.

## Threads and sessions

The adapter maps:

- `event.channel` to `conversationId`;
- `event.thread_ts ?? event.ts` to `threadId` for channel mentions;
- `event.thread_ts` to `threadId` for threaded DMs, and no `threadId` for
  top-level DMs;
- `event.user` to `actor`;
- `team_id`, `channel_type`, event type and `ts` to metadata.

`resolveSessionId` returns an existing Fevex session. The first run creates it;
the host stores `run.run.sessionId` afterwards. Prefix ids with the workspace and
persist the mapping when one app serves multiple workspaces or processes.
Authorization remains in the host.

## Retries and idempotency

Slack retries events with the same `event_id`. The webhook claims that id
through `SlackStore` before starting a run. The included in-memory store is
per-process. For a single host and restarts, use SQLite:

```ts
import type { SlackDelivery } from '@fevex/slack';
import { createSQLiteChannelStore } from '@fevex/sqlite';

const store = createSQLiteChannelStore<SlackDelivery>({ filename: '.fevex/slack.db' });
const adapter = createSlackAdapter({ signingSecret, botToken, store });
```

For multiple workers, implement `SlackStore` on a shared database:

```ts
interface SlackStore {
  claimEvent(eventId: string): boolean | Promise<boolean>;
  getDelivery(deliveryId: string): SlackDelivery | undefined | Promise<SlackDelivery | undefined>;
  saveDelivery(deliveryId: string, delivery: SlackDelivery): void | Promise<void>;
}
```

The adapter stores the Slack `{ channel, ts }` receipt under the stable
`deliveryId` before returning it, so a retried final answer or elicitation
prompt reuses the original message. Slack's `chat.postMessage` has no reliable
public idempotency key; a crash between Slack accepting a post and saving its
receipt can still duplicate a message. Use a durable outbox when that window
matters.

## Elicitation

When an agent pauses, the adapter posts the prompt and its JSON Schema as text
in the thread. Ask the responder to send a JSON object, then resume with the
authenticated actor:

```ts
await app.resumeRun(runId, {
  type: 'elicitation',
  requestId,
  value: JSON.parse(replyText),
  actor: { id: slackUserId, type: 'user' },
});
```

A Slack user id is an identity hint, not authorization. Check the run and
conversation relationship before calling `resumeRun`.

## Not included

OAuth installation, multi-workspace token management, Block Kit cards, slash
commands, shortcuts, attachments and loading prior thread history are not part
of this adapter. They belong to the host or a later extension.
