---
title: Models
description: Applications depend on the small ModelGateway contract, never on a vendor SDK directly.
---

Applications depend on the small `ModelGateway` contract, never on a vendor SDK
directly. A gateway streams `output.delta` fragments followed by exactly one
`completed` event.

## The ModelGateway contract

```ts
import type { ModelGateway } from '@fevex/core/models';

export const model: ModelGateway = {
  async *stream(input) {
    for await (const event of yourProvider.stream(input)) {
      if (event.type === 'text.delta') {
        yield { type: 'output.delta', delta: event.text };
      } else if (event.type === 'completed') {
        yield { type: 'completed', result: { output: event.output } };
      }
    }
  },
};
```

FEVEX rejects a missing or duplicate terminal, post-terminal events, and a final
output that does not match the accumulated deltas.

## Official adapters

Official adapters implement this contract for you:

```ts
import { createOpenAI } from '@fevex/openai';

const model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })('gpt-5.6');
```

DeepSeek follows the same shape:

```ts
import { createDeepSeek } from '@fevex/deepseek';

const model = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY!,
})('deepseek-v4-flash');
```

Structured output is only parsed as JSON and validated when the agent declares
an `outputSchema`; otherwise model text is preserved exactly as a string.
