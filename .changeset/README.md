# Releases with Changesets

This guide describes Fevex's installed Changesets CLI **3.0.1** and its custom
batch publisher. Like Eve, changesets are created in the repository-root
`.changeset/` directory, and the version PR consumes them. Use the repository
scripts below; the generic Changesets `publish` command is not part of this workflow.

## Stay in alpha without publishing

Fevex currently uses the `alpha` prerelease state in `pre.json`. Changesets owns
the version counters and dependency updates. Do not edit package versions,
`pre.json` counters or `release-plan.json` manually as part of ordinary changes.
Do not run `pre enter alpha` again or `pre exit` while continuing this alpha phase.

**Alpha controls versioning; it does not disable publication.** Keep the repository
Actions variable `ENABLE_NPM_PUBLISH` absent or set to `false` during rehearsals.
Only the exact value `true` enables the automated npm job. Changing a local file
does not set this GitHub variable.

For now, npm publication is limited to `@fevex/core`, `@fevex/deepseek` and
`@fevex/openai`. Changesets may still version other workspace packages when core
changes, and CI tests all nine, but those other packages are excluded from npm
publication and GitHub release tags. The two published adapters declare an exact
core version. When core changes, Changesets updates that version and the workflow
publishes core before the adapters. Their versions retain `-alpha.N`, while npm
publication explicitly advances the `latest` dist-tag. A bare
`npm install @fevex/core` then resolves to that alpha release. Any older `alpha`
dist-tag remains unchanged.

Recommended routine: keep adding changesets for real changes, validate source PRs,
and leave the generated release PR open until a release is wanted. Automation
updates that PR as more changes reach `main`. There is no need to publish alpha
versions, add fake changesets, or merge version bumps just to test packaging.

## Add a changeset to a source PR

1. Implement the change and run its tests.
2. Run `bun run changeset`. Select each public package you directly changed, the
   SemVer impact (`patch`, `minor` or `major`), and a useful changelog entry. Alpha
   is the prerelease channel, not a fourth impact choice. For incompatible changes,
   describe the migration; do not select `patch` just because the project is alpha.
3. Commit the generated `.changeset/<name>.md` alongside the source change.
4. Open the PR and let CI validate it. Source, manifest and package README changes
   require changeset coverage; test-only changes and docs outside packages do not.

For example, a fix to the OpenAI adapter could generate:

```markdown
---
"@fevex/openai": patch
---

Fix cancellation handling when a streaming response is interrupted.
```

Changesets computes any additional dependent-package bumps. A core change can
update several adapters, including exact dependencies and peer dependencies.
Review the generated plan instead of predicting or editing the next alpha number.

## Rehearse locally

From the repository root, with Bun 1.3.2 and Node 24/npm 11.15.0:

```bash
bun install --frozen-lockfile
bun run changeset status
bun run test:release
bun run release:rehearse
```

- `status` shows pending releases without changing versions.
- `test:release` exercises real version generation in temporary repositories,
  including adapter-only and core-wide releases, without changing this checkout's
  versions or publishing anything.
- `release:rehearse` builds and packs all nine packages into `/tmp/fevex-release`,
  installs the tarballs into temporary consumers, and runs them with your current
  Node executable. It then reads npm metadata to report publication readiness
  for the three currently enabled npm packages.
  It needs network access for installs/registry reads, but no publishing credentials.
  Build outputs change locally; package versions do not.

The local rehearsal does not replace the source suite or PostgreSQL integration.
CI runs those checks and repeats the consumer tests on Node 20, 22 and 24.

## Rehearse in GitHub Actions

Once the workflow is on `main`, open **Actions → Package releases → Run workflow**
and select `main`. Manual dispatch is always a rehearsal, even if publication is
enabled later. It neither creates a release PR nor publishes packages/tags/releases.

Check the validation jobs, the `rehearse` summary and the `npm-release` artifact
(retained for seven days). The `publish` and `record` jobs must be skipped. Registry
inspection reports `not ready` for missing packages, conflicting versions or other
blockers without failing the rehearsal. A green run therefore proves the build
and tests passed, not that npm authentication or OIDC is configured correctly.

## From a source PR to publication

After a changeset reaches `main`, automation creates or updates
`changeset-release/main`. Its `ci:version` command generates versions, changelogs,
`bun.lock` and `release-plan.json`. Review and merge that PR separately from source
changes. Check that its versions retain `-alpha.N`, the dependency updates are
correct and CI passes. In alpha mode, Changesets 3 moves consumed `.md` files from
`.changeset/` to `.changeset/pre/` for the eventual stable release. Only new
changesets at the root are pending; files under `pre/` are already consumed. Eve's
normal release mode deletes consumed files instead. The Fevex publisher uses the
explicit release plan, not a count of `.md` files.

| Action | Result |
| --- | --- |
| Merge a source PR with a changeset | Validate, then create/update the version PR; no npm write. |
| Leave the version PR open | Keep accumulating reviewed changes; no version bump on `main`. |
| Merge the version PR with publication disabled | Commit alpha versions/changelogs and rehearse the batch; no npm write or release tags. |
| Merge the version PR with publication enabled and npm configured | Validate, publish planned tarballs in dependency order, then record tags/GitHub Releases. |
| Manually run Package releases on `main` | Validate and inspect only; never publish. |

To test the complete merge path without npm, first verify `ENABLE_NPM_PUBLISH`
is absent/`false`, then merge a real version PR and inspect the run. This advances
repository versions and consumes its changesets even though npm remains unchanged.
Prefer keeping the PR open for ordinary rehearsals to avoid unnecessary bumps.

Enabling publication later does not publish a previously rehearsed batch. Prepare
a new version PR from subsequent changes after activation. Finish one release
batch before merging the next; an ordinary source push does not resume an old one.

See the [maintainer guide](../.github/MAINTAINER_GUIDE.md#package-releases) for
activation, bootstrap packages and recovery from partial publication failures.
For prerelease concepts, see the [official Changesets guide](https://changesets.dev/guide/prereleases).
