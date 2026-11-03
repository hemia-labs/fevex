---
title: Compatibility & releases
description: Public API, persistence and release guarantees for FEVEX.
---

FEVEX is pre-1.0. This page defines what is public, what can change between
releases and how persisted runs survive upgrades. The repository `docs/`
directory is internal and is not published; this page, the package READMEs and
the rest of this site are the public documentation.

## Public surface

| Surface | Status |
| --- | --- |
| Documented imports from official package subpaths | Public API |
| Types exported from those subpaths | Public API |
| Error codes and event types emitted by the runtime | Public behavior |
| HTTP v3 routes, request/response bodies and SSE events | Public behavior |
| Exported `RunTrace` schema | Public behavior |
| Runs, sessions and event journals stored by the host | Host-owned data |
| Checkpoints (`RunCheckpoint`, `WorkflowCheckpoint`) | Private implementation detail |
| `src/internal`, non-exported files, `docs/`, examples and scripts | Not public API |
| Model `providerState` and provider payloads | Opaque; no compatibility promise |

The `exports` field of each official package is the source of truth for what can
be imported. Importing an undocumented file or relying on a checkpoint shape is
unsupported even if it happens to work today.

Additive changes are normal: new optional fields, event types, error codes and
exports may appear in a minor release. Consumers should tolerate unknown event
types and fields rather than treating them as a failure. Removing or renaming a
documented export, event type, field or error code is a breaking change. HTTP v3
and `RunTrace.schemaVersion` are versioned separately; additive fields may appear
within a version, while a new version is required for breaking changes.

## Versioning

Official packages are currently released as `0.1.0-alpha.N`. Alpha releases may
change the public API between `N` releases.

| Change | SemVer before 1.0 |
| --- | --- |
| Compatible bug fix, security fix or documentation update | `patch` |
| New feature, or a justified breaking change with migration notes | `minor` |
| Stable 1.0 boundary | `major` |

A `minor` release may contain a breaking change while the project is pre-1.0,
but it must be called out in the `CHANGELOG.md`, the pull request and the release
notes with the migration path. A `patch` release never removes public API or
changes persisted data incompatibly. After 1.0, FEVEX follows normal Semantic
Versioning.

Changesets record the impact above. While the project stays in the alpha channel,
the published npm version advances the `-alpha.N` counter; the recorded impact is
used for changelogs and for preparing beta, rc and stable versions. Published
versions are immutable and are never reused with different contents.

Deprecated public APIs are documented before removal. After 1.0 they remain
available for at least one minor release. Before 1.0, removal can happen in a
minor release with migration notes; no fixed deprecation window is guaranteed.

## Persisted runs and checkpoints

Run and session storage is owned by the host. FEVEX provides the contracts and
official store adapters, but access control, backups and retention remain the
host's responsibility.

- Store migrations are forward-only. SQLite migrates automatically when opened
  and refuses a database newer than the running package. PostgreSQL requires an
  explicit `migrate()` call before serving traffic.
- Downgrading the runtime or store schema is not supported. Back up the store
  before upgrading.
- Checkpoints are private, versioned data. A runtime that encounters an
  unsupported checkpoint version fails with `CHECKPOINT_UNSUPPORTED` instead of
  guessing. Do not read, write or migrate checkpoints from application code.
- Resuming also verifies the declared definition fingerprint. Changes to an
  agent, workflow, team, tool or model surface fail with
  `RUN_DEFINITION_CHANGED` rather than continuing with a different definition.
  The workflow `run` body is not fingerprinted; bump the workflow `version` when
  closed-over behavior changes.
- The event journal is append-only and ordered. New event types and fields may
  appear; consumers should ignore anything they do not understand.

### Upgrade checklist

1. Pin exact versions of FEVEX packages in production.
2. Read the package changelogs and release notes for breaking changes.
3. Upgrade `@fevex/core` and the official adapters in the same release batch;
   adapters depend on the exact core version.
4. Back up the run store and run the required store migrations.
5. Finish, cancel or explicitly test paused runs before upgrading the runtime.
6. Roll out through staging or a canary and verify run creation, resume and
   recovery before promoting.

## Release process

Releases use Changesets and a reviewed version pull request:

1. A source pull request includes a changeset for public code, manifests or
   package README changes. CI builds, typechecks, tests and smoke-tests tarballs.
2. Automation creates or updates the version pull request with versions,
   changelogs, dependency updates and `.changeset/release-plan.json`.
3. Merging the version pull request with publication enabled publishes only the
   reviewed plan, in dependency order and with npm Trusted Publishing.
4. Tags and GitHub Releases are recorded only for packages actually published.

The npm release pipeline publishes exactly `@fevex/core`, `@fevex/openai` and
`@fevex/deepseek`. The other integrations are repository-only and are not
published; they remain outside the npm compatibility guarantee until they enter
that published inventory. See [Install](/docs/install/) and
[Adapters](/docs/adapters/) for the current inventory.

Alpha versions are published on the npm `latest` tag so a bare install gets the
newest prerelease. Pin exact versions for reproducible deployments. There is no
fixed release cadence, long-term support branch or backport guarantee; fixes
target `main` and the latest published prerelease. Security reports follow the
[security policy](https://github.com/hemia-labs/fevex/blob/main/SECURITY.md).

## Supported environments

| Component | CI-tested support |
| --- | --- |
| Node.js runtime | 20, 22 and 24 (tarball consumer smoke) |
| Module format | ESM only |
| TypeScript toolchain | 5.7+ |
| PostgreSQL | 16 |
| SQLite | `better-sqlite3` on Node and `bun:sqlite` on Bun |
| Bun (development and tests) | 1.3.2 |

Other Node or database versions may work, but they are not part of the tested
support matrix until CI covers them.
