# Fevex open-source repository setup

This guide documents the recommended branch, review, CI and release configuration.
Files in Git do not activate repository settings. The checklist below must be
verified by a repository administrator; it does not claim those settings are
already enabled.

## What is in the repository

| File | Purpose | Activation |
| --- | --- | --- |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Development and contribution process | Merge into the default branch |
| [`SECURITY.md`](../SECURITY.md) | Vulnerability reporting and maintenance scope | Merge; separately enable private reporting |
| [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Community expectations and moderation contact | Merge; monitor the listed contact |
| [`pull_request_template.md`](pull_request_template.md) | Problem, validation, compatibility and docs checklist | Merge into the default branch |
| [`bug_report.yml`](ISSUE_TEMPLATE/bug_report.yml) | Package versions, environment, behavior and reproduction | Merge into the default branch |
| [`feature_request.yml`](ISSUE_TEMPLATE/feature_request.yml) | Use case, proposed behavior and alternatives | Merge into the default branch |
| [`config.yml`](ISSUE_TEMPLATE/config.yml) | Security policy link and allowance for blank issues | Merge into the default branch |
| [`test-framework.yml`](workflows/test-framework.yml) | Framework validation with temporary PostgreSQL 16 | Workflow exists; make its check required separately |
| [`deploy-fevex.yml`](workflows/deploy-fevex.yml) | Website validation and deployment | Deployment requires the configured environment and credentials |
| [`publish-packages.yml`](workflows/publish-packages.yml) | CI on main, Changesets version PRs and batch publication | Dry run by default; npm publishing needs separate activation |

The guide lives under `.github/` because root `docs/` is currently ignored by Git.
Decide which existing roadmaps should be versioned separately; do not silently
publish all local documents by removing that ignore rule.

## Branches and merges

Use `main` as the default branch and short-lived feature/fix/docs branches. A
permanent `develop` branch is unnecessary for the current release process.

In **Settings → General → Pull Requests**:

- Enable squash merging and use the PR title as the squash commit title.
- Disable merge commits and rebase merging if squash is the chosen project policy.
- Enable automatic deletion of merged head branches.

In **Settings → Rules → Rulesets**, create an **Active** branch ruleset named
`Protect main`, targeting the default branch or `main` explicitly:

| Rule | Recommended value |
| --- | --- |
| Require a pull request before merging | Enabled |
| Require status checks to pass | Enabled |
| Required check | `Framework validation`, from GitHub Actions |
| Require branches to be up to date before merging | Enabled |
| Require conversation resolution | Enabled |
| Require linear history | Enabled |
| Block force pushes | Enabled |
| Restrict deletions | Enabled |
| Bypass list | Empty by default; narrowly assigned emergency access only if needed |

Run the workflow once before selecting its check. Select the actual reported job
name `Framework validation` and keep it stable; renaming it requires updating
the ruleset.

With at least two active maintainers, require one approval and dismiss stale
approvals when new commits modify the reviewed code. For a solo maintainer,
start with zero required approvals while keeping PRs and CI mandatory; authors
cannot approve their own PRs. Add mandatory review once another reviewer can
actually provide it. Do not create a routine admin bypass to work around an
unusable review policy.

Test enforcement with a small PR: the check should be pending while CI runs,
a failed check should prevent merge, and an eligible passing PR should be mergeable.
Do not test protection by force-pushing `main`.

Reference: [available rules for GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

## PR review policy

Use a Conventional Commit PR title, such as `fix(runtime): preserve history`.
The title becomes the squash commit; perfect intermediate commit formatting is
not required. This convention is documented, not currently enforced by a title check.

Reviewers should verify observable behavior, regression coverage and public
contract impact. For run/store/tool changes, examine cancellation, retries,
concurrency and recovery. For API or checkpoint changes, request migration notes.
Avoid demanding artificial tests or migrations for changes that do not need them.

`CODEOWNERS` is not added yet because ownership should name confirmed GitHub
users or teams with write access, not invented accounts. Once agreed, create
`.github/CODEOWNERS` and assign paths such as `/packages/fevex/`,
`/packages/postgres/`, `/packages/browser/` and `/.github/`. Verify GitHub resolves
each owner, then enable required code-owner review if the maintainer team can
support it. An email contact for conduct is not a substitute for code ownership.

## CI policy

The Quality Gate runs on PRs and is reused by the main-branch release workflow.
It installs with the frozen Bun lockfile, builds once, typechecks/tests packages
in separate jobs, validates the Nest API example and tests tarball consumers.
PostgreSQL 16 runs in an isolated service with test-only credentials; no production
database is used.

`FEVEX_REQUIRE_POSTGRES=1` prevents missing connection configuration from silently
skipping integration. Browser preview uses mocks; passing this CI does not certify
real Chrome automation or production readiness of every package.

Keep the mandatory workflow free of top-level path filters. The website workflow
currently has path filters, so do not require its check for every PR as-is: a
workflow that never starts can leave a required check pending. Add an always-running
final check that accounts for unaffected areas before making conditional validation
mandatory.

Remaining validation improvements:

1. Extend the existing tarball consumer tests with package-specific usage cases.
2. Confirm minimum Node patch versions beyond the current major-version matrix.
3. Validate a pinned real `agent-browser` and Chrome against a controlled local page
   before declaring browser integration supported.
4. Add scheduled crash/recovery, load and long-running resource tests.

Deploy and publish only the validated commit. The website deploy currently runs
independently on `main`; document that limitation until an explicit quality-gate
dependency or equivalent validation is added for the deployment path.

## Actions and repository security

In **Settings → Actions → General**, keep default workflow token permissions
read-only and require approval for workflow runs from outside collaborators
according to the project's trust policy. Avoid granting PR workflows permission
to create or approve pull requests.

Use `pull_request` to test fork code without production secrets. Do not use
`pull_request_target` to check out and execute untrusted PR code. Use GitHub-hosted
ephemeral runners for external contributions. Restrict deploy and release
credentials to trusted jobs and environments.

Pin actions to reviewed full commit SHAs with version comments and automate
updates. Framework and package release actions are pinned to commit SHAs. The
website workflow still uses version tags and needs the Node-24 action and explicit
Ubuntu runner updates already applied to the Quality Gate.

Enable Dependabot alerts and review dependency changes. To automate version
updates, add `.github/dependabot.yml` for GitHub Actions and the supported package
ecosystem, checking current Bun lockfile support before choosing update tooling.
Group routine updates and keep major upgrades reviewable.

Reference: [secure use of GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use).

## Private reporting and moderation

In **Settings → Advanced Security**, enable **Private vulnerability reporting**
(the sidebar location may appear under Security and quality). Then verify the
repository's **Security → Advisories → Report a vulnerability** route and subscribe
responsible maintainers to security notifications. Never test it by publishing a
real vulnerability in an ordinary issue.

`SECURITY.md` and the issue chooser explain the private route and a safe fallback
when it is unavailable. GitHub reporting is not enabled automatically by either
file. The conduct contact is `cristian.mendez@hemia.mx`; arrange monitoring and an
uninvolved reviewer for complaints when possible.

Reference: [configure private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

## Package releases

Releases use Changesets 3.0.1, Changesets action v2.1.1, Bun 1.3.2 and npm Trusted Publishing. The workflow
[`publish-packages.yml`](workflows/publish-packages.yml) now runs on pushes to
`main`; **tag pushes no longer publish**. Manual dispatches on `main` are always
rehearsals. Actual npm writes remain disabled until the repository Actions
variable `ENABLE_NPM_PUBLISH` equals `true`.

### How changes reach npm

1. A source PR includes a changeset (`bun run changeset`). CI requires coverage
   of changes to public code, manifests and package READMEs. It exempts tests.
2. On `main`, the release workflow first runs the reusable Framework validation.
   It then creates or updates the `changeset-release/main` version PR using
   Changesets. No npm permissions are present in the PR-generation job.
3. `bun run ci:version` delegates version/dependency/changelog generation to
   Changesets, updates `bun.lock`, and records the changed public versions in
   `.changeset/release-plan.json`. Apps and examples remain private/unversioned.
4. Review and merge the version PR separately. It must contain only generated
   version metadata, changelogs, changeset state and lockfile changes. CI rejects
   batches mixed with source edits or a plan that differs from the version diff.
5. The merged commit is validated again. Its tarballs are reused from that CI run;
   the publisher selects only `@fevex/core`, `@fevex/deepseek` and `@fevex/openai`
   from the reviewed plan. It checks those packages before writing, publishes core
   before the adapters, and verifies integrity and channels after each write.
6. A separate job records the verified packages as GitHub Releases and lightweight
   tags. Only this job receives the write permission needed for release records;
   the npm job has `contents: read` and `id-token: write`. Alpha versions are
   marked as prereleases and are not marked as the repository's Latest release.

An ordinary push without a changed, valid release plan does not publish anything,
including packages missing from npm. Publication does not depend on the absence
of changeset files: alpha mode moves consumed files to `.changeset/pre/`. Manual rehearsals cannot
publish or create a version PR.
Changesets may version other packages when core changes; CI still validates all
nine. The six deferred packages get no npm publication, tag or GitHub Release.
OpenAI and DeepSeek depend on the exact core version prepared in the same release,
not on npm's mutable `latest` dist-tag. Alpha versions are published with
`--tag latest`, so bare npm installs resolve to the newly published alpha. Any
older `alpha` dist-tag remains unchanged.

The root scripts are:

```bash
bun run changeset          # add a changeset to a source PR
bun run test:release       # helper tests and real Changesets/Bun fixture rehearsals
bun run release:rehearse   # build all tarballs, test Node consumers, inspect npm
```

`ci:version` changes versions and the lockfile. It is intended for the release PR
bot; run it manually only while deliberately preparing a version PR. The fixture
tests run it in temporary repositories without changing Fevex package versions.

### Recommended alpha rehearsal policy

Keep `.changeset/pre.json` in `mode: pre`, `tag: alpha`, and keep the repository
Actions variable `ENABLE_NPM_PUBLISH` absent or `false`. Alpha versions can still
be published; the variable is the independent publication switch. Do not exit
prerelease mode or manually reset its counters for a rehearsal.

Use the [Changesets contributor and rehearsal guide](../.changeset/README.md)
for commands, a sample changeset and expected results. For routine development,
merge source PRs with real changesets and leave the generated version PR open.
Run **Package releases** manually on `main` for a full validation without changing
versions. Its `publish` and `record` jobs are always skipped. PR checks validate
the proposed versions on the release PR before it is merged.

Merging a version PR with publication disabled is an optional end-to-end rehearsal:
it advances versions in Git and consumes changesets but leaves npm unchanged.
Enabling the variable afterward does not retroactively publish that batch; prepare
a new version PR for a later release. Registry `not ready` reports are informational
in rehearsal mode, so inspect the summary even when the run is green. Rehearsals
do not test OIDC credentials or prove the first real publication will succeed.

### CI organization

`test-framework.yml` runs directly on PRs, or is called by the `main` release
workflow. This avoids running a second copy of CI for every push to `main`.
It also supports manual dispatch. Source validation is split into jobs:

- Tooling/changeset checks, including real versioning rehearsals.
- One build of all nine packages, ordered by their internal dependencies.
- Eight package jobs, with at most four running concurrently; each typechecks and
  tests its package and reuses the build artifact.
- PostgreSQL tests/typecheck in a separate job with PostgreSQL 16 and
  `FEVEX_REQUIRE_POSTGRES=1`.
- Nest API typecheck and integration tests.
- Clean consumers on Node 20, 22 and 24, installing the same tarballs, importing
  every public subpath and exercising SQLite's native Node store contract.

The final job retains the name **Framework validation** for PR protection. It
fails if any required job fails, is canceled or is unexpectedly skipped. Keep
that PR check required and verify its reported name when activating the workflow;
GitHub can display reusable-workflow jobs with a caller prefix on `main` runs.
No affected-package filtering or Turbo dependency is introduced. Source tests use
Bun; the Node matrix actually executes Node, using the latest patch of each major.
It does not certify every older minor/patch allowed by `engines: >=20`.

Artifacts `package-builds` and `npm-release` are retained for seven days and are
bound to the run's commit. The OIDC job installs no workspace dependencies and
executes no package lifecycle scripts; it publishes the inspected `.tgz` files.

### Activation and one-time setup

Before enabling npm writes:

- Merge the workflows, configuration, scripts and lockfile. In Actions, run
  **Package releases → Run workflow** on `main` and review the rehearsal results.
- Allow GitHub Actions to create PRs in repository Actions settings. With the
  default `GITHUB_TOKEN`, generated PR workflows may require a maintainer to
  approve their execution. For unattended CI, optionally configure a GitHub App:
  repository variable `RELEASE_APP_ID` and secret `RELEASE_APP_PRIVATE_KEY`.
  Install it only on this repository with contents and pull-request write access.
  The workflow mints a short-lived token; it never automatically approves or merges
  the release PR. Verify generated PR checks before enabling publication.
- Configure npm Trusted Publishing for the three enabled packages with owner `hemia-labs`, repo
  `fevex`, workflow `publish-packages.yml` and environment `npm`. Explicitly allow
  direct `npm publish`. No `NPM_TOKEN` secret is used. The publisher pins npm 11.15.0
  on a GitHub-hosted Node 24 runner. Provenance requires a public package/repo.
- Set the `npm` environment deployment branch policy to **main**. Replace the
  tag-only policy from the initial design; keeping it would block this workflow.
- Protect `main` and keep the PR checks mandatory. If release tags are protected,
  allow the automation actor to create them while blocking modification/deletion.
- The other six package names can remain absent from npm. If they are enabled in
  a later release, resolve their initial publication and ownership first; CI
  deliberately refuses to bootstrap missing packages.
- Finally set the repository Actions variable `ENABLE_NPM_PUBLISH=true`. This
  permits automatic publication of subsequently merged version-only release plans.

No external setting above is activated by a local file change. The implementation
queried npm without changing it: `core`, `openai` and `deepseek` existed at
`0.1.0-alpha.1`, and six other names returned 404. The six missing names are
currently excluded from publication. Existing `latest` tags pointed to older
alpha versions. The local core tarball also differed from the version already
published; prepare a new core version so the two adapters can depend on that exact
artifact. Historical dist-tags require a separate explicit maintainer decision.

### Version policy and failure recovery

Packages version independently. Changesets updates exact internal dependencies
and OpenTelemetry's peer dependency when core changes. A tested local dependency
must have the same integrity as the version eventually available in npm.
`pre.json` starts in alpha mode with the current package versions as its baseline;
no package version was bumped to install this tooling. New changesets produce the
next version PR. Test fixtures cover adapter-only and core-wide releases, consumed
alpha changesets moved to `.changeset/pre/`, private workspaces and the frozen Bun lockfile.

Maintain explicit prerelease versions; for now alpha publishes advance npm `latest`,
while beta and rc retain their own dist-tags. The publisher
rejects unknown formats, backwards channel moves, conflicting published content
and dependencies absent from both npm and the reviewed batch. Treat channel
transitions as release work using Changesets, not edits to counters. Once a stable
line exists, maintain future prereleases on a separate branch with its own policy.

The entire release workflow is serialized on `main` with cancellation disabled.
GitHub concurrency is not a durable FIFO queue: newer pending runs can replace
older pending runs. Finish one batch before merging another. A later source push
will not silently resume publication of the old plan. Rerun the original release
run when recovering; its checkout and artifacts refer to the reviewed commit.

Inspect npm after an uncertain result. Preflight catches known blockers before
any publication, but a network/auth failure mid-batch can still leave a partial
release. Re-run failed jobs with the retained tarballs: an exact matching version
and channel is a no-op; differing content requires a new version or manual review.
`published-packages` records verified progress. GitHub release recording is separate
and retryable, so failure to create a tag never rolls back npm. An existing tag with
a different target (or an annotated tag needing review) is not overwritten.

An accepted `npm publish` may appear as **Validating** while npm scans it, before
the version becomes installable. The publish job waits up to 30 minutes per
package for the exact tarball integrity and `latest` dist-tag, with a 100-minute
job limit for up to three sequential packages. It records GitHub releases only
after every selected package is visible. If npm holds a version longer or
blocks it, inspect its status in npm; rerun the failed job only after the
version is available.
The script will verify an already published matching version without uploading
it again. **Staged** is a different state requiring maintainer approval with
2FA; a stage-only Trusted Publisher rejects this workflow's direct `npm publish`
instead of silently staging it.

An activation change alone does not publish an old batch, and manual dispatch is
always read-only. If a version PR was rehearsed while publishing was disabled,
prepare a new version PR once activation is complete. Do not mix source changes
into a release plan merely to retrigger it.

References: [Changesets action v2](https://github.com/changesets/action),
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and
[GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## Activate and extend the templates

1. Merge these files into the default branch (`main`). Merely keeping them on a
   feature branch does not activate the default repository templates.
2. Open **Issues → New issue** and verify **Bug report**, **Feature proposal** and
   the security policy link. Blank issues remain available for questions or
   private-contact requests without sensitive details.
3. Open a new PR and verify the description is prefilled from
   `.github/pull_request_template.md`. Existing PR descriptions are not rewritten.
4. To add another issue form, create a uniquely named YAML file in
   `.github/ISSUE_TEMPLATE/` with `name`, `description` and `body`; use stable,
   unique field IDs and mark only essential fields required.
5. To change the default PR template, edit `.github/pull_request_template.md`.
   A Markdown PR template is advisory; its checkboxes do not enforce branch rules.

The supplied forms avoid labels and assignees that might not exist. If you add
`labels`, create the corresponding labels in GitHub first. No GitHub App, secret
or additional workflow is required to display these templates.

References: [issue form syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)
and [PR templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository).

## Administrator activation checklist

Unchecked items require confirmation in GitHub; they are not assertions that the
current remote settings are absent.

- [ ] Merge community files and templates into `main` and verify their rendering.
- [ ] Enable squash merge and automatic branch deletion.
- [ ] Activate the `main` ruleset with the existing Quality Gate check.
- [ ] Set review requirements appropriate to the number of maintainers.
- [ ] Enable private vulnerability reporting and verify notifications.
- [ ] Verify Actions permissions and outside-collaborator workflow approval policy.
- [ ] Confirm conduct mailbox monitoring.
- [ ] Assign actual owners before adding `CODEOWNERS` and required owner reviews.
- [ ] Run the release rehearsal on GitHub and expand the supported-runtime matrix.
- [ ] Configure protected release tags, the `npm` environment and npm Trusted Publishing before enabling `ENABLE_NPM_PUBLISH`.
