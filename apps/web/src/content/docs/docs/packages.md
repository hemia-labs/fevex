---
title: Package subpaths
description: The public subpaths exported from the single @fevex/core package.
---

All subpaths ship in the same `@fevex/core` package. Your app imports only the
domains it uses, and each subpath is a small export barrel.

| Import | Purpose |
| --- | --- |
| `@fevex/core` | Common runtime, definitions and contracts |
| `@fevex/core/agents` | Agent definitions |
| `@fevex/core/artifacts` | Artifact descriptors, local stores and S3-compatible adapter |
| `@fevex/core/tools` | Tool, connection and provider contracts |
| `@fevex/core/models` | Provider-neutral model contracts |
| `@fevex/core/workflows` | Durable workflow definitions |
| `@fevex/core/teams` | Multiagent team definitions |
| `@fevex/core/runtime` | Runs, sessions and store contracts |
| `@fevex/core/channels` | Channel adapters and message handling |
| `@fevex/core/knowledge` | Context providers, code-first and `SKILL.md` skills, `AGENTS.md` and memory contracts |
| `@fevex/core/sandbox` | Sandbox contract and local development sandbox |
| `@fevex/core/policies` | Authorization policy contracts |
| `@fevex/core/observability` | Trace, bounded export queue, redaction and cost contracts |
| `@fevex/core/evals` | Datasets, scorers, reporters and regressions |
| `@fevex/core/testing` | Deterministic testing helpers |
