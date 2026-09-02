---
title: Workflows & teams
description: Compose agents into durable, restartable workflows, and coordinate them with teams.
---

Workflows compose agents into durable, restartable runs. Teams add an opt-in
coordination layer on top of the same durable engine.

## Durable workflows

A workflow definition owns the input, output, event and limit contracts, and
requires a `DurableRunStore`.

```ts
import { defineWorkflow } from '@fevex/core';
import { z } from 'zod';

const review = defineWorkflow({
  name: 'review',
  version: '2',
  inputSchema: z.object({ draft: z.string() }),
  outputSchema: z.string(),
  limits: { maxSteps: 8, maxToolCalls: 12 },
  async run(step, input) {
    const draft = await step.agent('draft', 'writer', { input });
    const approval = await step.waitForEvent('approval', 'review.approved');
    return `${draft.output} (${approval.actor?.id})`;
  },
});
```

Input is validated before the initial checkpoint is stored, and output is always
validated with the definition schema — including after a pause or recovery.
`stepId` is the durable identity of a step: keep it stable while its meaning is
stable, and increment `version` when replay order or step meanings change.

## Recovery

Paused runs resume with `resumeRun`; an external worker can recover an orphaned
`running` run after its lease expires:

```ts
await app.recoverRun(runId, {
  actor: { id: 'recovery-worker', type: 'service' },
});
```

FEVEX does not poll globally: deployments need an external orphan detector and a
scheduler that calls `resumeRun` for elapsed timers.

## Teams

Teams reuse registered agents under a supervisor and **cannot** widen an agent's
model, tools, policies, sandbox or limits.

```ts
import { defineTeam } from '@fevex/core';

const softwareTeam = defineTeam({
  name: 'software-team',
  version: '1',
  supervisor: 'planner',
  members: [
    { agent: 'researcher', role: 'research' },
    { agent: 'coder', role: 'implementation' },
    { agent: 'reviewer', role: 'review' },
  ],
  limits: { maxDelegations: 12, maxParallel: 2 },
  async run(team, input) {
    // coordinate members…
  },
});
```

For the full durable-execution, compensation and cancellation semantics, see the
[core README](https://github.com/hemia-labs/fevex/blob/main/packages/fevex/README.md).
