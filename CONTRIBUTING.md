# Contributing to Fevex

Fevex is an alpha TypeScript framework. Focused bug reports, documentation fixes,
tests and integrations with a demonstrated use case are welcome. Follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the
[security policy](SECURITY.md), not a public issue.

## Before starting

Search existing issues and pull requests. For a new public API, dependency,
integration or architectural change, open a feature proposal before a large PR.
Small fixes and documentation improvements can go directly to a PR.

Keep provider SDKs and infrastructure in optional packages. Prefer existing
contracts and native functionality over another abstraction or dependency.

## Local setup

Use Bun `1.3.2`, as declared in `package.json`. Node `24` matches the framework
CI. Consumer runtime requirements are declared separately by each package.

```sh
git clone https://github.com/hemia-labs/fevex.git
cd fevex
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run build
```

Contributors without write access should fork the repository, clone their fork
and open a PR against `hemia-labs/fevex:main`.

The full build includes examples and the website. The Next.js example currently
fetches Google Fonts during its build, so that build needs network access.
Model API keys are not needed for the automated source tests.

For a focused package change:

```sh
bun run --cwd packages/browser test
bun run --cwd packages/browser typecheck
bun run --cwd packages/browser build
```

Package test scripts discover tests inside `src`, including browser preview,
without discovering compiled tests in `dist`. Use `bun run test` from the root;
bare `bun test` can discover generated files left by example builds.

## PostgreSQL and browser tests

The `Framework validation` workflow starts a temporary PostgreSQL 16 service.
It sets `FEVEX_POSTGRES_URL` and `FEVEX_REQUIRE_POSTGRES=1`, so the integration
suite cannot silently skip because its connection URL is missing.

Locally, three PostgreSQL integration tests skip when `FEVEX_POSTGRES_URL` is
absent. You do not need Docker to contribute: GitHub Actions runs that service.
To reproduce the integration locally, point the variable at a dedicated test
database and run the PostgreSQL package tests. Tests create the `fevex` schema
and records; never use a production database.

Browser tests use a simulated sandbox. They do not install Chrome or validate
the external `agent-browser` binary. See the [browser package](packages/browser/README.md)
and [PostgreSQL package](packages/postgres/README.md) for their boundaries.

## Pull requests

1. Create a short-lived branch from `main`, such as `fix/session-conflict`,
   `feat/provider-name`, `docs/quickstart`, or `codex/task-name`.
2. Keep the change focused and preserve unrelated changes.
3. For a behavior fix, add a regression test that demonstrates the problem.
   Documentation-only changes do not need artificial tests.
4. Run the affected tests, typecheck and build. State any unavailable checks.
5. Complete the PR template and explain compatibility or migration effects.
6. Address review comments and satisfy the repository's required checks.

Use a Conventional Commit title, for example `fix(runtime): preserve session
history`. PRs are intended to merge using squash, so intermediate commit titles
do not need to be rewritten for style alone. Mark breaking changes with `!`
and explain their migration in the PR body.

Changes to runs, tools or storage must consider cancellation, retries,
idempotency, concurrent access and recovery. Changes to public types, exports,
errors, events, checkpoints or workflow behavior must describe compatibility.
During alpha, a justified API replacement is possible; accidental incompatibility
is still a bug.

Do not include credentials, private prompts, customer data or production traces
in code, logs, screenshots or reports. Use synthetic reproduction data.

## Documentation and releases

Update the relevant README or public documentation with behavior changes.
Public website documentation lives in `apps/web/src/content/docs/`.
The root `docs/` directory is currently ignored by Git; do not put required
contributor documentation there and assume it will be published.

Package publishing is a maintainer responsibility. Do not change package
versions or publish as part of an unrelated PR. Contributions use the repository's
[Apache-2.0 license](LICENSE).

Maintainers can find branch rules, release recommendations and template activation
instructions in the [maintainer guide](.github/MAINTAINER_GUIDE.md).
