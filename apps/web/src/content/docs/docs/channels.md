---
title: Channels & resolvers
description: Deliver requests through channel adapters and resolve them through the shared resume API.
---

Channels connect message transports to the agent runtime. The host receives and
authenticates an input, then calls `handleChannelInput` from
`@fevex/core/channels`. The adapter parses it into a `ChannelMessage` and delivers
the agent's answer. An input parsed as `null` is ignored without starting a run.

## Delivering an elicitation

An agent with `elicitation: 'pause'` can request external information. When it
pauses, `handleChannelInput` calls the adapter's optional `deliverElicitation`
hook. Implement the hook to present the prompt and its `responseSchema` in your
transport:

```ts
import type { ChannelAdapter, ChannelMessage, ChannelOutput } from '@fevex/core/channels';

const adapter: ChannelAdapter<ChannelMessage, string> = {
  name: 'memory',
  async parse(message) { return message; },
  async deliver(output) {
    // Persist and deduplicate output.deliveryId before returning a receipt.
    return output.deliveryId;
  },
  async deliverElicitation(request, context) {
    // Persist trusted routing before attempting external delivery.
    // The host owns conversation/thread -> { runId, requestId } correlation.
    const output: ChannelOutput = {
      deliveryId: context.deliveryId,
      conversationId: context.conversationId,
      threadId: context.threadId,
      content: request.prompt,
      metadata: { runId: context.runId, requestId: request.id },
    };
    return this.deliver(output, context);
  },
};
```

`ChannelElicitationContext` contains `runId`, `sessionId`, `conversationId`, an
optional `threadId`, `deliveryId`, and an optional `AbortSignal`. The request
contains its ID, prompt, response schema, creation time and optional `expiresAt`.
The result has `ignored: false`, the stored paused `run`, the delivery receipt
and `elicitation`. Its `output.content` is the request prompt.

Without the hook, the helper throws `ChannelError` with
`code: 'CHANNEL_ELICITATION_UNSUPPORTED'` and a `runId`; the request remains
paused and recoverable. Expired requests are rejected before delivery.

## Correlating a response

The host stores the original message and associates the request with its tenant,
channel, conversation and thread. Authenticate each responder and authorize that
relationship before calling the runtime. Derive `actor` from trusted identity:

```ts
await app.resumeRun(route.runId, {
  type: 'elicitation',
  requestId: route.requestId,
  value: { account: 'account-42' },
  actor: { id: authenticatedActor.id, type: 'user' },
});
```

Fevex validates the request ID, actor, expiration and response schema before
resuming. Invalid or duplicate responses do not replay effects. The host must
also prevent a response from selecting another tenant's run. Request IDs alone
are not authorization.

`resumeRun` schedules continuation and can return a running run. Observe the
committed event journal or inspect `getRun` until the run completes or pauses
again. Then deliver its next request or final result:

```ts
import { deliverChannelRun } from '@fevex/core/channels';

await deliverChannelRun(route.runId, originalMessage, { fevex: app, adapter });
```

The helper delivers completed agent runs and elicitation pauses. It rejects
running, cancelled and failed runs, other pause types, workflows and teams.
The supplied message is trusted routing data; retain and authorize it in the
host rather than accepting arbitrary destination IDs from a reply.

## Retries and durable delivery

An elicitation's delivery key is `elicitation:${runId}:${requestId}`. Every
retry of that stored request receives the same key. The final answer uses the
original message's `deliveryId`, which the host must keep stable and unique
within the transport's scope. A new request in the same run has a new key.

On delivery failure, `ChannelError.runId` identifies the stored run. Retry with
`deliverChannelRun`, retaining the original message and destination. Calling
`handleChannelInput` again starts another run; it is not a delivery retry.

The adapter or transport must deduplicate these keys. Use a persistent outbox
and delivery receipts for production; the helper does not guarantee exactly-once
effects in arbitrary external systems. Inbound webhook deduplication also
belongs to the host. Use a [persistent run store](/docs/adapters/) and persist
routing records to recover after a process restart.

`onEvent` observes local `channel.received`, `channel.delivered` and
`channel.failed` events. Delivery events include `runId` and, for requests,
`requestId`. This callback is not a durable queue. The returned `events` combine
the run's committed journal with local channel events; channel events themselves
are not persisted by the helper.

## Human, service and agent resolvers

All resolvers consume the same `elicitation.requested` event and call
`resumeRun({ type: 'elicitation', ... })`. A UI forwards an authenticated human
response. A service looks up authorized data and submits it with
`actor.type: 'service'`. An agent resolver consumes the same request and submits
an authorized result with `actor.type: 'agent'`.

External workers consume committed events through `listEvents` or the event
stream, retain a cursor and tolerate repeated events. Inspect the current pause
before resolving a replayed request. The core requires no resolver registry,
queue, form or messaging provider.

The [runnable channel and resolver example](https://github.com/hemia-labs/fevex/tree/main/examples/channel-elicitation)
uses a deterministic model and in-memory transport, including a delivery retry
and human and service responses. From the repository root:

```bash
bun run examples/channel-elicitation/index.ts
```

For adapter contract tests, pass an optional `elicitation` fixture to
`testChannelAdapter` from `@fevex/core/testing`, containing `request`, `context`
and the expected `delivered` receipt. The helper calls the hook twice and checks
that both receipts match. Also test that your transport performs only one
external effect for the repeated key.

## Data and audit

Use `expiresAt` for time-sensitive requests. Keep credentials in the credential
store; do not request tokens or passwords through elicitation. Request and
response data can enter the persisted run and conversation history. Minimize
PII, isolate tenants, protect stores and define retention rules. Audit request
IDs, delivery receipts and responder identity without logging secrets.
