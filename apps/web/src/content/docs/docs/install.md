---
title: Install
description: Install the FEVEX core package, official model adapters and an optional schema library.
---

## Core package

```bash
npm install @fevex/core
```

FEVEX targets Node.js 20+ and ships as ESM only.

## Model adapters

Provider integrations are separate packages, so your app installs only what it
uses:

```bash
npm install @fevex/core @fevex/openai
npm install @fevex/core @fevex/deepseek
npm install @fevex/core @fevex/mcp
```

See [Adapters](/docs/adapters/) for the full list.

## Schemas

Schemas are optional. The examples use Zod 4, but any Standard
Schema-compatible validator works:

```bash
npm install zod
```
