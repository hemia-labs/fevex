# Security policy

## Scope and maintenance

Fevex is in alpha. Security reports for code on `main` and the latest published
version of each official `@fevex/*` package are welcome. Fixes target current
development and upcoming releases; backports to older alpha versions are not
guaranteed. This is not a long-term support or production-readiness commitment.

Report suspected authorization bypasses, cross-session or cross-tenant access,
credential exposure, unsafe tool execution, persistence integrity issues, or
package/workflow supply-chain problems even if you are unsure of their impact.

## Reporting privately

Use GitHub's [private vulnerability reporting form](https://github.com/hemia-labs/fevex/security/advisories/new)
when available. This requires maintainers to enable private vulnerability
reporting in repository settings; adding this file does not enable it.

If the private form is unavailable, open an issue requesting a private security
contact **without including the vulnerability, reproduction, secrets or affected
user data**. Wait for a private channel before sharing technical details.
Do not submit exploit details in a public issue or pull request.

Include in the private report:

- Affected package versions or commit and runtime/store/provider configuration.
- Expected boundary and observed behavior.
- Minimal reproduction using synthetic data.
- Preconditions, impact and any suggested mitigation.

Test only systems and data you are authorized to use. A local reproduction is
preferred over testing against another user's deployment.

Maintainers will assess the report, discuss a fix and coordinate disclosure and
release notes with the reporter. Response and resolution times depend on
maintainer availability; no fixed service level or bounty is promised.

## Deployment responsibilities

- The hosting application owns authentication and authorization for each run,
  session, stream and mutation. Possession of a run ID is not authorization.
- Tool approvals and policies complement host authorization; they do not replace it.
- Model output and browser/MCP/OpenAPI content are untrusted inputs.
- The built-in local sandbox is for trusted development execution, not operating
  system isolation of untrusted code.
- Protect run history, checkpoints and tool results separately from redacted
  telemetry; configure retention and access to the backing store.
- Keep production credentials out of fork PR workflows and use isolated test
  databases for integration tests.

These responsibilities do not exclude reports of defects in Fevex's documented
contracts. Please report uncertain cases privately rather than assume they are
out of scope.
