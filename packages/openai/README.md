# @fevex/openai

Official OpenAI `ModelGateway` adapter for Fevex.

```bash
npm install @fevex/core @fevex/openai
```

```ts
import { createOpenAI } from '@fevex/openai';

const model = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  organization: process.env.OPENAI_ORG_ID,
  project: process.env.OPENAI_PROJECT_ID,
  schemaPolicy: 'strict',
})('gpt-5.6');
```

The adapter uses native `fetch` and implements only the Fevex model contract.
Runtime behavior such as tool execution, validation, events and retries belongs
to `@fevex/core`. Returned gateways include `metadata: { provider: "openai",
model: modelId }` for traces, eval cost calculators and OpenTelemetry export.

## Text, tools and continuation

Without `outputSchema`, OpenAI text is returned as the exact string supplied by
the Responses API, even when it looks like JSON. With `outputSchema`, the
adapter requires valid JSON before Fevex performs local schema validation.
Refusals, incomplete responses and malformed function calls fail explicitly.

During tool loops the adapter stores the original response items, including
[reasoning items required by Responses API](https://platform.openai.com/docs/api-reference/responses-streaming/response/refusal?lang=python),
in opaque `providerState`. Fevex returns that state to the next model step
automatically. Direct `ModelGateway` consumers must do the same; the state is
run-local and must not be inspected. The adapter's `stateCodec` lets Fevex
persist it only inside a private durable checkpoint.

Core reasoning efforts are forwarded to `reasoning.effort`;
`provider-default` leaves provider options untouched. Model-specific effort
support remains an OpenAI capability and an unsupported value is reported by
the API. Provider-only settings can be supplied through
`modelOptions.reasoning`.

The adapter always uses the Responses streaming API. It emits only
`response.output_text.delta` as visible output and builds the terminal result
from `response.completed`; reasoning and partial function arguments remain
private.

Tool names and `schemaName` must match `[A-Za-z0-9_-]{1,64}`. Fevex-owned
fields such as model, input, tools, tool choice, schema format, parallel calls
and output caps override conflicting `modelOptions`. Background provider jobs
and built-in tools remain outside this gateway.

## Schema policy

`schemaPolicy` defaults to `"strict"`. Before sending a request, the adapter
checks tool inputs and final outputs against OpenAI's documented
[Structured Outputs subset](https://developers.openai.com/api/docs/guides/structured-outputs).
Every schema must have an object root; every object must require all its
properties and set `additionalProperties: false`. Unsupported keywords and
documented size limits throw `OpenAIError` with
`code: "PROVIDER_SCHEMA_UNSUPPORTED"` before `fetch` runs.

Set `schemaPolicy: "best-effort"` to send tools with `strict: false`. Object
outputs use JSON mode and other JSON values use a schema instruction. Fevex
still validates the returned value locally, but OpenAI does not guarantee schema
adherence in this mode, so the caller may need to retry an invalid result.

| Policy | Tool input | Final output |
| --- | --- | --- |
| `strict` | OpenAI strict function schema | Structured Outputs |
| `best-effort` | Non-strict function schema | JSON mode or JSON instruction |
