# @fevex/slack

Slack Events API channel adapter for Fevex. It verifies Slack request
signatures, maps mentions and DMs to `ChannelMessage` values, replies in
threads, and delivers elicitation prompts.

The package is repository-only until it is added to the npm release inventory.

## Setup

Create a Slack app with the `app_mentions:read` and `chat:write` bot scopes.
Add `im:history` and subscribe to `message.im` for direct messages. Do not
subscribe to both `app_mention` and `message.channels` for mentions; Slack sends
separate event ids and both would start a run. Use `message.channels` (and
`allowChannelMessages: true`) only for ambient channel messages. Set the Events
API request URL to your handler and install the app in the workspace.

```bash
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=xoxb-...
SLACK_BOT_USER_ID=U...
```

## HTTP handler

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
    resolveSessionId: (message) => sessions.get(message.threadId ?? message.conversationId),
  },
);

if (result.done) {
  void result.done.then((run) => {
    if (!run.ignored) {
      sessions.set(run.message.threadId ?? run.message.conversationId, run.run.sessionId);
    }
  }).catch((error) => console.error(error));
}
return new Response(result.body, {
  status: result.status,
  headers: result.status === 200 && result.body ? { 'content-type': 'application/json' } : undefined,
});
```

Slack expects a 2xx response within three seconds. `handleSlackWebhook` verifies
the request, answers `url_verification`, claims the event id, and returns before
the agent finishes. Observe `done` or queue it; do not wait for the agent before
acknowledging. In serverless hosts, enqueue the work before responding so the
runtime is not frozen after the acknowledgment. Do not pass the webhook's
request `AbortSignal` as the run signal if it aborts when the response ends.

`resolveSessionId` returns an existing Fevex session. The first run creates it;
store `run.run.sessionId` after that run. The example uses one session per Slack
thread and one session per DM channel. Prefix conversation or thread ids with
the workspace when a single app serves multiple workspaces.

## Deduplication

Slack retries events with the same `event_id`. `handleSlackWebhook` claims it
through `SlackStore` before starting a run. The included
`createInMemorySlackStore` works for one process. For restarts, use the SQLite
implementation from `@fevex/sqlite`:

```ts
import type { SlackDelivery } from '@fevex/slack';
import { createSQLiteChannelStore } from '@fevex/sqlite';

const store = createSQLiteChannelStore<SlackDelivery>({ filename: '.fevex/slack.db' });
```

For multiple workers, implement `SlackStore` on a shared database:

```ts
interface SlackStore {
  claimEvent(eventId: string): boolean | Promise<boolean>;
  getDelivery(deliveryId: string): SlackDelivery | undefined | Promise<SlackDelivery | undefined>;
  saveDelivery(deliveryId: string, delivery: SlackDelivery): void | Promise<void>;
}
```

`claimEvent` must be atomic across workers (for example, a unique insert).
`getDelivery`/`saveDelivery` store the Slack `{ channel, ts }` receipt keyed by
the stable `deliveryId`, so a retried final answer or elicitation prompt reuses
the original message.

Slack's Web API does not provide a reliable idempotency key for
`chat.postMessage`; this package stores receipts instead of relying on one.
A crash between Slack accepting a post and saving its receipt can still produce
a duplicate. Use a durable outbox when that window matters.

## Elicitation replies

When an agent pauses for elicitation, the adapter posts the prompt and its JSON
Schema as text in the thread. Ask the responder to reply with a JSON object, then
call `resumeRun` with the parsed value:

```ts
const value = JSON.parse(replyText);
await app.resumeRun(runId, {
  type: 'elicitation',
  requestId,
  value,
  actor: { id: slackUserId, type: 'user' },
});
```

Authorize the responder and the run relationship before resuming. A Slack user
id is an identity hint, not authorization by itself.

## Security and scope

- Signature verification uses `X-Slack-Request-Timestamp` and
  `X-Slack-Signature` over the raw request body, with a five-minute window and a
  constant-time comparison. Verify before parsing JSON.
- Bot messages, edits and unrelated Events API payloads are ignored.
- Channel messages without a bot mention are ignored unless
  `allowChannelMessages: true`; DMs are accepted.
- The adapter does not implement OAuth installation, Block Kit cards, slash
  commands, attachments, threads with loaded history, or multi-workspace token
  management. Those belong to the host or a later channel extension.
