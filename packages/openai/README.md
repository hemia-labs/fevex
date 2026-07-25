# @fevex/openai

Official OpenAI `ModelGateway` adapter for Fevex.

```bash
npm install fevex @fevex/openai
```

```ts
import { createOpenAI } from '@fevex/openai';

const model = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  organization: process.env.OPENAI_ORG_ID,
  project: process.env.OPENAI_PROJECT_ID,
})('gpt-5.6');
```

The adapter uses native `fetch` and implements only the Fevex model contract.
Runtime behavior such as tool execution, validation, events and retries belongs
to `fevex`.
