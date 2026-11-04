# Pilot incidents and manual work

## 2026-11-03 — Internal reference pilots

Environment: Node 24, `@fevex/core@0.1.0-alpha.6`, repository tarballs for
`@fevex/openai`, `@fevex/deepseek` and `@fevex/sqlite`. Clean consumer created by
`bun run pilots`.

| Pilot | Result | Evidence |
| --- | --- | --- |
| Support API | Pass | HTTP start, approval pause/resume, completed refund, shutdown |
| Research workflow | Pass | Workflow event pause/resume, completed output, eval score 1 |
| Crash recovery | Pass | `SIGKILL`, one `run.started`, `run.recovered`, completed output |

### Observations

1. **Repository-only durable store.** `@fevex/sqlite` is not published to npm, so
   the clean consumer installs its repository tarball. An external pilot needs
   access to a Fevex release artifact or a published store before it can run a
   durable workload. This is already documented in FEV-104; no code defect.
2. **Actors are host-owned.** HTTP resume requires the handler context to provide
   an authenticated actor. The pilot uses a user for start and a reviewer for
   approval. This is the intended authorization boundary.
3. **Recovery waits for the lease.** A killed worker is not recoverable until its
   30 second lease expires. The pilot waits 31 seconds before recovering. This is
   expected fencing behavior, not a hang.
4. **Upgrade is manual.** The harness validates clean install, operation and crash
   recovery. It does not automate upgrading from the previous published release
   because those tarballs are not retained in the repository.

### Manual work

- Built local release tarballs before installing the clean consumer.
- Installed the repository-only SQLite tarball explicitly.
- Waited for lease expiry before invoking `recoverRun`.
- Kept the approval and workflow resolution actors explicit in the pilot scripts.

No core bug or undocumented API requirement was found. External pilots remain
pending; record them below using the same format.
