# @fevex/slack

## 0.1.0-alpha.16

### Minor Changes

- 12e2da8: Add the agent identity contract and remove `ExecutionContext.actor`.
  
  `ExecutionContext.identity` is now the only source of truth:
  
  ```ts
  {
    identity: {
      actor: { id: 'alice' },
      agent: { id: 'researcher' },
      tenant: 'tenant-a',
      scopes: ['repo:read'],
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  }
  ```
  
  This is a breaking change for hosts, channel adapters, credential stores and
  tests that pass `context.actor`. Migrate to `context.identity.actor` and declare
  scopes explicitly.
  
  Adds:
  
  - `Actor` and `AgentIdentity` types plus identity helpers.
  - Scope and tenant delegation invariants for workflow and team child runs.
  - Identity expiry checks before starting or resuming runs.
  - `ResolvedCredential` metadata and binding to actor, tenant, scopes and expiry.
  - `CredentialStore.refresh` and `CredentialStore.revoke` hooks.
  - `IDENTITY_INVALID`, `IDENTITY_EXPIRED`, `CREDENTIAL_EXPIRED`,
    `CREDENTIAL_SCOPE_DENIED` and `CREDENTIAL_IDENTITY_MISMATCH` errors.
  
  Channel messages now carry `identity` instead of `actor`.
  
  OAuth PKCE, OAuth refresh/revocation, a delegation audit event and a
  multi-tenant example remain future FEV-304 work.

### Patch Changes

- Updated dependencies [12e2da8]
  - @fevex/core@0.1.0-alpha.16

## 0.1.0-alpha.15

### Patch Changes

- Updated dependencies [6596921]
  - @fevex/core@0.1.0-alpha.15

## 0.1.0-alpha.14

### Patch Changes

- Updated dependencies [77059a9]
  - @fevex/core@0.1.0-alpha.14

## 0.1.0-alpha.13

### Minor Changes

- 726eb18: Add a first-class Slack Events API channel adapter with request signature
  verification, mention and DM parsing, thread-aware replies, idempotent delivery
  receipts and elicitation prompts.

### Patch Changes

- Updated dependencies [726eb18]
  - @fevex/core@0.1.0-alpha.13
