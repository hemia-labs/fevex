---
title: Overview
description: FEVEX is a code-first, provider-neutral Agent Engineering Framework for TypeScript.
---

FEVEX is an Agent Engineering Framework for code-first, provider-neutral AI
agents in TypeScript. It gives you the small contracts needed to define agents,
tools, model adapters, validation and tests without adopting a heavy runtime.

:::caution[Early MVP]
FEVEX is usable for bounded local agent runs, but its API may change before the
first stable release.
:::

## Why FEVEX

- **Provider-neutral** — application code depends on `ModelGateway`, not a model
  vendor SDK.
- **Typed tools** — Standard Schema validators infer inputs and validate every
  runtime boundary.
- **Small runtime** — one package, ESM, Node.js 20+, no database or service
  required.
- **Observable** — successful and failed runs emit structured events and
  optional local traces.
- **Testable** — `@fevex/core/testing` ships a deterministic model and shared
  model contract checks; `@fevex/core/evals` adds local regression suites.

## Next steps

- [Install](/docs/install/) the core package and any adapters you need.
- Run the [Quickstart](/docs/quickstart/) — a full model → tool → model cycle
  with no network access.
- Learn the core concepts: [Agents](/docs/agents/), [Tools](/docs/tools/) and
  [Models](/docs/models/).
