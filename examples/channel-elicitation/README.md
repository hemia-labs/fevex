# Channel elicitation and external resolvers

Run from the repository root, after installing workspace dependencies:

```bash
bun run examples/channel-elicitation/index.ts
```

No server, API key or browser is required. A deterministic model asks for an
account. The first conversation receives a human reply; the second is resolved
by a service consuming committed `elicitation.requested` events. Both use the
same `resumeRun` API and then deliver the final answer through the channel.

The example asserts four unique deliveries and four model calls, despite a
repeated request delivery and a duplicate human response. To typecheck it:

```bash
bun x tsc -p examples/channel-elicitation/tsconfig.json
```

The host owns `conversationId -> { runId, requestId }` correlation. The Maps here
are only for this demo: use durable records scoped by tenant, channel,
conversation and thread in production. Store routing before external delivery
so a transport timeout does not lose the paused run. Retry delivery with
`deliverChannelRun`, not with a fresh `handleChannelInput` call.

`context.deliveryId` is stable for an elicitation. A transport must deduplicate
that key, or the host must implement a durable outbox with equivalent semantics.
Fevex supplies the key but does not promise exactly-once delivery to arbitrary
external systems. Deduplicating inbound webhooks also belongs to the host.

Authenticate the responder, authorize the conversation/run relationship, and
derive `actor` from trusted identity. Never let a reply select an arbitrary
run. Fevex validates request identity, schema and expiration, and rejects stale
or duplicate responses without replaying effects. The demo does not authenticate
users; its actor IDs are fixed trusted fixtures.

Use `expiresAt` for time-sensitive requests. Do not ask for tokens or passwords
through elicitation. Request and response data can enter the event journal and
conversation history: minimize PII, protect the store and set retention rules.
Keep delivery receipts and responder identity for audits; avoid logging secrets.

An agentic resolver can consume the same committed event and submit an authorized
result with `actor.type: 'agent'`. It has the same validation and authorization
requirements as human or service resolvers. No resolver registry is required.
