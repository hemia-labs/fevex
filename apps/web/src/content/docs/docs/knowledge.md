---
title: Knowledge & skills
description: Add code-first or SKILL.md context with progressive disclosure and AGENTS.md.
---

Knowledge providers add prompt context for a run without changing sessions or
the run store.

## Code-first skills

```ts
import { defineSkill } from '@fevex/core';

const app = createFevex({
  models,
  contextProviders: [
    defineSkill({
      name: 'refunds',
      instructions: 'Refunds are allowed for 30 days after purchase.',
    }),
  ],
  agents: [
    defineAgent({
      name: 'support',
      instructions: 'Answer with the available business context.',
      skills: ['refunds'],
    }),
  ],
});
```

`defineSkill` is eager: instructions and resources enter the prompt at the
start of every run.

## File skills

`loadSkillFile` reads one explicit `SKILL.md` file:

```ts
import { loadSkillFile } from '@fevex/core';

const refunds = await loadSkillFile('./skills/refunds/SKILL.md');
```

The file uses frontmatter:

```md
---
name: refunds
description: Handle refund requests and policy exceptions.
---

Refunds are allowed for 30 days after purchase. Escalate exceptions to a human.
```

Register the returned provider and reference its name from the agent:

```ts
const app = createFevex({
  models,
  contextProviders: [refunds],
  agents: [
    defineAgent({
      name: 'support',
      instructions: 'Answer with the available business context.',
      skills: ['refunds'],
    }),
  ],
});
```

Only `name` and `description` are advertised before the skill is loaded. When
the task matches, the model calls the reserved `fevex__load_skill` tool and the
body enters the conversation. `loadSkillFiles([...])` loads several explicit
paths; Fevex never scans directories for skills.

## Resources and scripts

After the body loads, files under `references/`, `scripts/` and `assets/` are
listed with their sizes. The model can read one on demand:

```json
{ "name": "refunds", "resource": "references/policy.md" }
```

Resources are read as UTF-8 text with a size cap. Scripts are listed but not
executed by Fevex in this release; running them requires a sandbox provider.

## AGENTS.md

`createAgentsMdContextProvider` reads one explicit file:

```ts
import { createAgentsMdContextProvider } from '@fevex/core';

const app = createFevex({
  models,
  contextProviders: [
    createAgentsMdContextProvider('./AGENTS.md'),
  ],
  agents: [
    defineAgent({
      name: 'support',
      instructions: 'Answer with the available business context.',
      context: ['agents-md'],
    }),
  ],
});
```

For multiple files, register one provider per file with a distinct `name`.

## Context budget and compaction

Set a per-agent or runtime-wide context budget to keep long conversations
inside the model window:

```ts
defineAgent({
  name: 'support',
  instructions: 'Answer with the available business context.',
  contextBudget: {
    contextWindow: 128_000,
    reserveOutputTokens: 8_000,
  },
});
```

Before each model call, Fevex estimates the prompt. When it crosses 80% of the
usable window, it replaces older completed turns with a summary, keeps system
instructions, the current request and the latest tool batch intact, emits
`context.compacted`, and saves the summary in the run checkpoint when the run
is durable. The original session history is not rewritten.

Compaction summarizes older completed turns and earlier tool batches in the
current turn. The latest tool batch is preserved, so pending tool calls and
approvals are never cut. The summary is cached on the session and reused across
runs; the original history remains the source of truth. If the latest batch
alone exceeds the usable window, the run fails with
`CONTEXT_BUDGET_EXCEEDED`; reduce the tool output, lower `maxSteps`, or raise
the budget.

The default estimator is deliberately conservative: it applies a `safetyFactor`
of 1.1 over a character-based count. Inject `compaction.estimateTokens` for a
real tokenizer. The `context.compacted` event carries at most 4,000 summary
characters; the full summary stays in the checkpoint.

The default compactor is deterministic and never calls a model. For semantic
summaries, use a separate model:

```ts
import { createModelContextCompactor } from '@fevex/core';

const app = createFevex({
  models,
  compaction: {
    compactor: createModelContextCompactor({ model: summaryModel }),
  },
});
```

Inject any other summarizer through `compaction.compactor`. Use
`compaction.redactSummary` to redact the summary before it enters the
`context.compacted` event; the checkpoint keeps the full summary. Read cumulative
runtime counters with `app.getCompactionStats()`.

`contextBudget.contextWindow` is the model context window.
`limits.maxInputTokens` remains the cumulative spend cap for a run.

## Boundaries

- Explicit paths only; no automatic skill or `AGENTS.md` discovery.
- Skill names use lowercase letters, numbers and hyphens, up to 64 characters.
- Default size caps are 256 KiB for `SKILL.md` and 256 KiB per resource.
- The original `SKILL.md` remains the source of truth; loaded content becomes
  part of the run messages.
