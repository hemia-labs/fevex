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

The current Quality Gate runs for every PR and pushes to `main`. It installs
with the frozen Bun lockfile, typechecks/builds the nine framework packages,
typechecks the Nest API example and runs source tests. PostgreSQL 16 runs in an
isolated service with test-only credentials; no production database is used.

`FEVEX_REQUIRE_POSTGRES=1` prevents missing connection configuration from silently
skipping integration. Browser preview uses mocks; passing this CI does not certify
real Chrome automation or production readiness of every package.

Keep the mandatory workflow free of top-level path filters. The website workflow
currently has path filters, so do not require its check for every PR as-is: a
workflow that never starts can leave a required check pending. Add an always-running
final check that accounts for unaffected areas before making conditional validation
mandatory.

Recommended additions, not implemented by this documentation change:

1. Install built tarballs in a clean consumer project and test public subpath imports.
2. Test each runtime version that the published package support policy promises.
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
updates. Current workflows still use version tags: this is a follow-up, not a
completed control. The website workflow also still needs the Node-24 action and
explicit Ubuntu runner updates already applied to the Quality Gate.

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

## Release policy to establish

Maintain `alpha`, `beta`, `rc` and stable `latest` channels. During alpha, label
incompatible changes explicitly and explain upgrades. Publish release notes that
identify affected packages and any API, checkpoint or storage migration.

Choose and document synchronized versus independent package versioning before
automating it. Current package versions are not all identical, so a synchronized
release must update dependencies deliberately.

Use a version PR, successful CI on the release commit, and then a protected tag
and publication workflow. Protect the tag pattern selected by the versioning
policy against update/deletion and restrict creation to release maintainers or
the publishing automation. Do not imply that `main` protection also protects tags.

Configure npm Trusted Publishing for each package with the exact organization,
repository and workflow identity. Give only the release job `id-token: write`;
use provenance and avoid long-lived npm publish tokens. Restrict any release
environment to trusted refs. These npm settings and the publication workflow are
not created by this change.

Reference: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

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
- [ ] Plan tarball validation and the supported-runtime matrix.
- [ ] Configure protected release tags and npm Trusted Publishing when publishing is automated.
