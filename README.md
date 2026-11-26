<p align="center">
  <img src=".github/assets/fevex-logo-ruby.svg" alt="FEVEX" width="480">
</p>

<p align="center">Agent Engineering Framework</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@fevex/core">
    <img src="https://img.shields.io/npm/v/%40fevex%2Fcore?style=flat&amp;label=npm&amp;color=B92432&amp;labelColor=34373D&amp;logo=npm&amp;logoColor=F3F0E8" alt="npm version">
  </a>
  <a href="https://github.com/hemia-labs/fevex/actions/workflows/test-framework.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/hemia-labs/fevex/test-framework.yml?style=flat&amp;label=CI&amp;labelColor=34373D" alt="Framework validation status">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/hemia-labs/fevex?style=flat&amp;label=license&amp;color=34373D&amp;labelColor=34373D" alt="License: Apache-2.0">
  </a>
  <a href="https://www.npmjs.com/package/@fevex/core">
    <img src="https://img.shields.io/node/v/%40fevex%2Fcore?style=flat&amp;label=Node.js&amp;color=34373D&amp;labelColor=34373D&amp;logo=nodedotjs&amp;logoColor=F3F0E8" alt="Supported Node.js versions">
  </a>
</p>

<p align="center">
  <a href="https://fevex.dev/docs/">Docs</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

## Overview

Build AI agents inside your TypeScript application. Define typed tools, swap
model adapters, and test the full model-to-tool loop locally with a built-in
deterministic model.

**Alpha.** APIs may change before the first stable release. See the
[compatibility and release policy](https://fevex.dev/docs/compatibility/).

## Quickstart

Run an agent with OpenAI on Node.js 20 or newer. It uses a local tool to check
the status of a sample account.

### Install

```sh
npm install @fevex/core @fevex/openai zod
```

### Run an agent

Save this as `quickstart.mjs`.

```js
import { createFevex, defineAgent, defineTool } from '@fevex/core';
import { createOpenAI } from '@fevex/openai';
import { z } from 'zod';

const getAccount = defineTool({
  name: 'get_account',
  description: 'Look up the status of a sample account.',
  inputSchema: z.strictObject({ accountId: z.number().int().positive() }),
  execute: ({ accountId }) => ({ accountId, status: 'active' }),
});

const model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('gpt-5.6');

const app = createFevex({
  models: { default: model },
  tools: [getAccount],
  agents: [defineAgent({
    name: 'support',
    instructions: 'Use get_account to answer account status questions.',
    tools: ['get_account'],
  })],
});

const result = await app.runAgent('support', { input: 'Is account 42 active?' });
console.log(result.output);
```

Set `OPENAI_API_KEY` in your environment, then run the example.

```sh
node quickstart.mjs
# Example output: Account 42 is active.
```

See the [deterministic Quickstart](https://fevex.dev/docs/quickstart/) or the
[adaptable agent starter](examples/starter/README.md).

## Packages

| Published package | Purpose |
| --- | --- |
| [`@fevex/core`](https://www.npmjs.com/package/@fevex/core) | Runtime, agent and tool definitions, testing, and evaluations. |
| [`@fevex/openai`](https://www.npmjs.com/package/@fevex/openai) | OpenAI model adapter. |
| [`@fevex/deepseek`](https://www.npmjs.com/package/@fevex/deepseek) | DeepSeek model adapter. |

See the [package inventory](https://fevex.dev/docs/install/) for installation
and integrations available from the repository, including MCP, OpenAPI, Slack,
and durable stores.

## Guides

| Task | Where to start |
| --- | --- |
| Define agents, validate tool inputs, and connect a model | [Agents](https://fevex.dev/docs/agents/) · [Tools](https://fevex.dev/docs/tools/) · [Models](https://fevex.dev/docs/models/) |
| Add skills, memory, channels, or external tools | [Knowledge and memory](https://fevex.dev/docs/knowledge/) · [Channels](https://fevex.dev/docs/channels/) · [Adapters](https://fevex.dev/docs/adapters/) |
| Coordinate agents and control tool execution | [Workflows and teams](https://fevex.dev/docs/workflows/) · [Approvals and durable runs](packages/fevex/README.md#approvals-and-durable-runs) |
| Debug, evaluate, and operate runs | [Tracing and debugging](https://fevex.dev/docs/development/) · [Evaluations](https://fevex.dev/docs/evals/) · [Operations](https://fevex.dev/docs/operations/) |
| Explore a working application | [Example catalog](examples/README.md) · [HTTP v3 playground](examples/nest-api/README.md) · [Studio](https://fevex.dev/docs/studio/) |

The [core reference](packages/fevex/README.md) details the runtime API, events,
sessions, limits, and public exports.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and tests, and follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Open bugs and proposals in
[GitHub Issues](https://github.com/hemia-labs/fevex/issues). Follow
[SECURITY.md](SECURITY.md) to report vulnerabilities privately.

The [maintainer guide](.github/MAINTAINER_GUIDE.md) covers releases and
[website deployment](.github/MAINTAINER_GUIDE.md#website-deployment).

## License

[Apache License 2.0](LICENSE)
