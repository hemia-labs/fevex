# A2A quote and reconnect (FEV-301)

A Fevex buyer requests a quote from a separate supplier built with the
[official A2A JavaScript SDK](https://github.com/a2aproject/a2a-js). The two use
[A2A 1.0 JSON-RPC](https://a2a-protocol.org/v1.0.0/specification/#9-json-rpc-protocol-binding)
against a configured loopback endpoint.

```sh
bun install --frozen-lockfile
bun run demo:a2a-quote
```

The demo generates OAuth access-token fixtures at runtime and uses a
deterministic buyer model and synthetic quotes. It runs with local HTTP and
temporary SQLite databases.

1. Verify the buyer token with `@fevex/core/identity/oauth`. Before
   `SendMessage`, persist Fevex's run ID, tool call ID and operation ID. Use the
   operation ID as the A2A message ID and save the supplier's task and context
   IDs from the acknowledgement.
2. Pause the Fevex run through elicitation. Close the buyer runtime and both
   SQLite connections. Keep the supplier running.
3. Reopen the buyer against the same databases. Check the stored tenant, actor
   and resume scope, then call `GetTask` for the saved ID. A working task
   leaves the run paused.
4. Once the supplier completes, race two buyers over the same persisted run.
   One resolves the original elicitation and the other is rejected. The
   event journal must contain exactly one start, resolution, resume and
   completion, and the supplier must have exactly one submission.

The demo also checks audience binding, cross-tenant resume denial at the buyer,
and task ownership at the supplier. A successful run prints the run, operation,
tool call, task and context IDs, one submission, one resume, and the quote.

For a real deployment, configure a trusted issuer and HTTPS endpoint and supply
a credential for the supplier's audience. The fixture supplier keeps tasks in
memory, so keep it running while testing buyer reconnection. If a send fails
before the buyer saves the acknowledgement, reconcile using the operation ID
before submitting again. The example reserves one submission per run and treats
an absent task ID as requiring reconciliation.
