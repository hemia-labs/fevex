# FEV-107 pilots

Reference pilots for Track 1. They install Fevex from clean tarballs, use only
public APIs and exercise the paths a host application owns.

> **Scope:** these are internal reference pilots. They prove installation,
> public contracts, approval/resume, workflow pause/resume, evals, graceful
> shutdown and crash recovery. They do not replace two independent external
> applications, which are still required to close FEV-107.

## Run

```bash
bun run pilots
```

The command builds the twelve tarballs once, creates a temporary consumer,
installs `@fevex/core`, `@fevex/openai`, `@fevex/deepseek` and the
repository-only `@fevex/sqlite`, then runs both pilots and a real `SIGKILL`
recovery check.

Options:

```bash
bun run pilots --skip-recovery
bun run pilots --keep
bun run pilots --report pilots/reports/local.json
```

The evidence report is written to `pilots/reports/latest.json`.

## Pilot 1 — Support API

Application: a support agent with a refund tool that requires human approval.

Flow:

1. Start over HTTP v3 with an authenticated `pilot-user`.
2. The tool requests approval and the run pauses.
3. A `pilot-reviewer` approves through the HTTP resume endpoint.
4. The tool executes, the run completes and the event journal contains the full
   approval sequence.
5. `shutdown` drains the runtime.

Verifies: clean install, HTTP host, authorization context, SQLite durability,
approval, resume, events and shutdown.

## Pilot 2 — Research workflow

Application: a research workflow that drafts with an agent, waits for a publish
event and also runs a deterministic evaluation.

Flow:

1. Start the durable workflow.
2. The child agent completes and the workflow pauses at `publish-approval`.
3. Resume with an explicit event and actor.
4. Verify the workflow output and event journal.
5. Run an eval case against the same agent.

Verifies: clean install, durable workflow, child-agent history, event resume,
evals and shutdown.

## Pilot 3 — Crash recovery

The harness starts a child worker against SQLite, kills it with `SIGKILL`, waits
for the 30 second lease to expire, and recovers the orphaned run in a second
process.

Verifies: one `run.started`, a `run.recovered` event, contiguous event history,
completed output and no duplicate run.

## Incident and manual-work log

See [INCIDENTS.md](./INCIDENTS.md). Add one entry per external pilot with:

- package and Node versions;
- install source and upgrade path;
- scenario and expected result;
- observed failure or friction;
- manual workaround, owner and follow-up.

## What remains for external pilots

Each external pilot should repeat the same sequence on a clean machine:

1. Install from the published official packages; note whether a repository-only
   integration is needed.
2. Run its real workload and human approval or event flow.
3. Kill a worker and recover the run.
4. Upgrade to the next Fevex release and verify persisted runs.
5. Record incidents, manual work and compatibility findings in
   [INCIDENTS.md](./INCIDENTS.md).

The reference harness does not automate the upgrade step because the previous
published tarballs are not retained in the repository; upgrade remains a manual
pilot checklist item.
