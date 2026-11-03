---
"@fevex/core": minor
---

Add optional resource authorization to the HTTP host. `createFevexHttpHandler`
now accepts an `authorize` hook that runs before reads, event streams,
cancellation, resume, recovery and every start, plus `onRunStarted` so the host
can persist run and session ownership. The Nest example demonstrates two
isolated identities with bearer authentication.
