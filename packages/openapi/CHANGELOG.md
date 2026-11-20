# @fevex/openapi

## 0.1.0-alpha.16

### Patch Changes

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

### Patch Changes

- Updated dependencies [726eb18]
  - @fevex/core@0.1.0-alpha.13

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies [79956a0]
  - @fevex/core@0.1.0-alpha.12

## 0.1.0-alpha.11

### Patch Changes

- Updated dependencies [cea838e]
  - @fevex/core@0.1.0-alpha.11

## 0.1.0-alpha.10

### Patch Changes

- Updated dependencies [952e070]
  - @fevex/core@0.1.0-alpha.10

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
  - @fevex/core@0.1.0-alpha.9

## 0.1.0-alpha.8

### Patch Changes

- Updated dependencies [5752417]
  - @fevex/core@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- Updated dependencies [1146dcf]
  - @fevex/core@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- 7f203fe: Document the official npm inventory: only `@fevex/core`, `@fevex/openai` and
  `@fevex/deepseek` are published. The other six integrations remain
  repository-validated and are not published by the release pipeline.
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
  - @fevex/core@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies [1a68a1d]
- Updated dependencies [1a68a1d]
- Updated dependencies [1a68a1d]
  - @fevex/core@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies [f4f8020]
- Updated dependencies [f4f8020]
  - @fevex/core@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies [c5595c5]
  - @fevex/core@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies [d6322c3]
  - @fevex/core@0.1.0-alpha.2
