# @fevex/anthropic

> **Publication status:** validated in CI but not published to npm. Use this
> package from the Fevex repository until it is published.

Anthropic `ModelGateway` adapter for Fevex, implemented over the native Messages
API.

```ts
import { createAnthropic } from '@fevex/anthropic';

const model = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  schemaPolicy: 'strict',
})('claude-opus-5-5');
```

The adapter uses native `fetch` and implements only the Fevex model contract.
Runtime behavior such as tool execution, validation, events and retries belongs
to `@fevex/core`. Returned gateways include `metadata: { provider: "anthropic",
model: modelId }` for traces, eval cost calculators and OpenTelemetry export.

## Message shape

Fevex `system` messages become the top-level `system` parameter. Consecutive
`tool` messages are grouped into a single user turn containing `tool_result`
blocks, as the Messages API requires. Assistant tool-call turns replay the
original native content blocks.

## Text, tools and continuation

Without `outputSchema`, Anthropic text is returned as the exact provider string,
even when it looks like JSON. With `outputSchema`, the adapter requires valid
JSON before Fevex performs local schema validation. Refusals, truncated
responses and malformed tool calls fail explicitly.

When thinking is enabled, Anthropic requires the original thinking blocks and
signatures to be sent back with the next tool round. The adapter keeps those
blocks, together with `tool_use` blocks, in opaque `providerState`. Fevex carries
that state automatically between model steps; direct `ModelGateway` consumers
must pass it unchanged. The adapter's `stateCodec` lets Fevex persist it only
inside a private durable checkpoint. Thinking and `redacted_thinking` content is
never emitted as visible output.

`max_tokens` is required by the Messages API. The adapter uses 4,096 tokens by
default; `maxOutputTokens` and `modelOptions.max_tokens` cap it, with the
strictest value winning.

## Reasoning and API version

Core reasoning efforts map to `output_config.effort` (`low`, `medium`, `high`,
`xhigh` and `max`). `none` disables thinking with
`thinking: { type: "disabled" }`. `minimal` is rejected before HTTP with
`PROVIDER_REASONING_UNSUPPORTED`. `provider-default` leaves provider
`output_config` and `thinking` values untouched.

The default `anthropic-version` is `2026-10-21`. That API version removes the
`temperature`, `top_p` and `top_k` request parameters; pass
`apiVersion: "2023-06-01"` to use the older version. Provider-only settings can
be supplied through `modelOptions`, but Fevex-owned fields such as model,
messages, system, tools, tool choice, token caps, thinking and output schema
take precedence.

Usage adds `input_tokens`, `cache_creation_input_tokens` and
`cache_read_input_tokens`, then reports `output_tokens` and their sum as
`totalTokens`.

## Schema policy

`schemaPolicy` defaults to `"strict"`. Final outputs use
`output_config.format: { type: "json_schema", schema }`; tool inputs set
`strict: true`. The adapter checks the documented
[JSON Schema subset](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations)
before `fetch`:

- object root and `additionalProperties: false` on every object;
- at most 20 strict tools, 24 optional parameters and 16 union-type parameters
  per request;
- no recursive schemas, external `$ref`, `oneOf`, numeric or string-length
  constraints, or array constraints beyond `minItems` of 0 or 1;
- supported regex features only.

Unsupported schemas throw `AnthropicError` with
`code: "PROVIDER_SCHEMA_UNSUPPORTED"` before the request starts.

Set `schemaPolicy: "best-effort"` to send a schema instruction in the system
prompt instead and let Fevex validate the response locally. This mode does not
guarantee adherence and the caller may need to retry invalid output.

| Policy | Tool input | Final output |
| --- | --- | --- |
| `strict` | Anthropic strict tool schema (`strict: true`) | `output_config.format` JSON schema |
| `best-effort` | Schema forwarded without `strict` | System schema instruction plus local validation |
