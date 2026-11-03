---
"@fevex/core": minor
---

Add `shutdown({ timeoutMs })` with admission closure, graceful drain, forced
cancellation at the deadline, a bounded trace flush and a result that reports
timed-out or cancelled runs. New starts, resumes and recoveries fail with
`RUNTIME_CLOSED` (HTTP 503) after shutdown begins. Add repeatable soak and
crash-recovery harnesses covering memory stability, history integrity, overhead,
retention and recovery after `SIGKILL`.
