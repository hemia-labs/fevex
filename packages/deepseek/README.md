# @fevex/deepseek

Official DeepSeek `ModelGateway` adapter for Fevex.

```bash
npm install fevex @fevex/deepseek
```

```ts
import { createDeepSeek } from '@fevex/deepseek';

const model = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY!,
})('deepseek-chat');
```

The adapter uses native `fetch` and implements only the Fevex model contract.
Runtime behavior such as tool execution, validation, events and retries belongs
to `fevex`.
