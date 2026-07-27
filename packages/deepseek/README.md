# @fevex/deepseek

Official DeepSeek `ModelGateway` adapter for Fevex.

```bash
npm install @fevex/core @fevex/deepseek
```

```ts
import { createDeepSeek } from '@fevex/deepseek';

const model = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  schemaPolicy: 'best-effort',
})('deepseek-v4-flash');
```

The adapter uses native `fetch` and implements only the Fevex model contract.
Runtime behavior such as tool execution, validation, events and retries belongs
to `@fevex/core`. Returned gateways include `metadata: { provider: "deepseek",
model: modelId }` for traces, eval cost calculators and OpenTelemetry export.

## Text, tools and continuation

Without `outputSchema`, DeepSeek content is returned as the exact provider
string, even when it looks like JSON. With `outputSchema`, the adapter requires
valid JSON before Fevex performs local schema validation. Truncated, filtered
or malformed responses fail explicitly.

[Thinking-mode tool calls](https://api-docs.deepseek.com/guides/thinking_mode)
require `reasoning_content` to be sent back on the next request. The adapter
keeps it in opaque `providerState`, and Fevex carries that state automatically
between model steps. Direct `ModelGateway` consumers must pass it unchanged; it
is run-local and must not be inspected. The adapter's `stateCodec` lets Fevex
persist it only inside a private durable checkpoint.

`reasoning: "none"` disables thinking and `high` enables its native effort.
`minimal`, `low` and `medium` are rejected before HTTP with
`PROVIDER_REASONING_UNSUPPORTED`: DeepSeek only implements `high` and `max`,
while its lower effort names are compatibility aliases that resolve to `high`.
Provider-only `max` remains available through `modelOptions` when core
reasoning is `provider-default`.

The adapter always uses native Chat Completions SSE with usage enabled. Visible
content is streamed immediately, while reasoning and partial tool calls are
accumulated privately until the required `[DONE]` marker.

Tool names must match `[A-Za-z0-9_-]{1,64}`. Fevex-owned fields such as model,
messages, tools, tool choice, schema format, parallel calls and output caps
override conflicting `modelOptions`. Provider tools outside Fevex's function
contract are not enabled by this gateway.

## Schema policy

`schemaPolicy` defaults to `"strict"`. DeepSeek strict tool schemas require a
`baseURL` ending in `/beta`; the adapter validates their documented subset and
sets `strict: true` on every function according to the
[Tool Calls guide](https://api-docs.deepseek.com/guides/tool_calls/).
Unsupported keywords throw
`DeepSeekError` with `code: "PROVIDER_SCHEMA_UNSUPPORTED"` before `fetch` runs.

DeepSeek [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)
guarantees valid JSON but does not enforce a supplied JSON Schema, so final
`outputSchema` is rejected in strict mode. Use
`schemaPolicy: "best-effort"` to include the schema as a model instruction and
let Fevex validate the response locally. This mode does not guarantee adherence
and the caller may need to retry invalid output.

```ts
const strictTools = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  baseURL: 'https://api.deepseek.com/beta',
})('deepseek-v4-flash');
```

| Policy | Tool input | Final output |
| --- | --- | --- |
| `strict` | DeepSeek strict subset on `/beta` | Unsupported |
| `best-effort` | Non-strict function schema | JSON instruction plus local validation |
