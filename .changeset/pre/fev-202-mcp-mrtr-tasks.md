---
"@fevex/mcp": minor
---

Add MCP `2026-07-28` MRTR, Tasks and subscription support. The adapter handles
`input_required` elicitation through `onElicitation`, echoes opaque
`requestState`, retries with `inputResponses`, polls `tasks/get`, supplies task
input through `tasks/update`, and opens `subscriptions/listen` streams with an
`onNotification` callback. Sampling and roots input requests remain unsupported.
