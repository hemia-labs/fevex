---
title: Agents
description: Define typed agents with instructions, tools and an optional output schema.
---

An agent is a typed definition — instructions, the tools it may call, and an
optional `outputSchema` that structures and validates its result.

## Define an agent

```ts
import { defineAgent } from '@fevex/core';
import { z } from 'zod';

const support = defineAgent({
  name: 'support',
  instructions: 'Answer account questions clearly.',
  tools: ['accounts_get'],
  outputSchema: z.object({ answer: z.string() }),
});
```

Agents are registered by name in `createFevex({ agents: [...] })` and reference
tools by name.

## Execution identity

Authenticated runs carry an `AgentIdentity` in `ExecutionContext.identity`:

```ts
const context = {
  identity: {
    actor: { id: 'alice', type: 'user' },
    agent: { id: 'support', type: 'agent' },
    tenant: 'tenant-a',
    scopes: ['repo:read', 'billing:read'],
    expiresAt: '2030-01-01T00:00:00.000Z',
  },
};
```

`actor` is the user or service on whose behalf the run executes. `scopes` is a
required part of the contract; use an empty array for unscoped local runs.
`tenant` is optional but should be set for multi-tenant hosts.

Workflows and teams receive the parent identity. A child cannot change the
actor or tenant, cannot add scopes, and cannot extend the expiry. An expired
identity fails before the run starts or resumes.

Credentials resolved through `CredentialStore` are bound to the identity:
credentials may declare `actorId`, `tenantId`, `scopes` and `expiresAt`. The
runtime fails closed on a mismatch instead of passing the value to a tool.

## Verify an inbound access token

`@fevex/core/identity/oauth` turns an OAuth credential into an `AgentIdentity`.
The host remains the only owner of sessions and credentials; Fevex never acts as
an authorization server.

```ts
import { createFevexHttpHandler } from '@fevex/core/http';
import { createJwtVerifier, verifyBearerToken } from '@fevex/core/identity/oauth';

const verifier = createJwtVerifier({
  issuer: 'https://idp.example.com',
  audience: 'https://api.example.com',
  jwksUri: 'https://idp.example.com/.well-known/jwks.json',
});

const handler = createFevexHttpHandler({ fevex: app });

export async function authenticated(request: Request) {
  const identity = await verifyBearerToken(
    verifier,
    request.headers.get('authorization'),
  );
  return handler(request, { context: { identity } });
}
```

The JWT backend verifies the signature with the issuer's keys, requires
`typ: at+jwt` (RFC 9068), an exact `iss`, the configured resource in `aud` and a
mandatory `exp`. It maps `sub` to the actor, `act.sub` to the delegated agent, a
namespaced claim or `tid` to the tenant, and `scope` or `scp` to the scope set.
Set `tenantClaims` or `agentClaim` when the issuer uses other claim names.

For opaque tokens, use `createIntrospectionVerifier` with the RFC 7662 endpoint
and client credentials. Both backends fail closed with `IDENTITY_INVALID`,
`IDENTITY_EXPIRED`, or `IDENTITY_UNAVAILABLE` when the issuer cannot be reached.

Clock skew defaults to 60 seconds. Only asymmetric algorithms (`RS256`, `PS256`,
`ES256`, `EdDSA`) are accepted.

## Run an agent

```ts
const result = await app.runAgent('support', {
  input: 'What is the status of account 42?',
});
```

The run executes a bounded multi-step model-tool loop with sequential tool
execution. When `outputSchema` is present, the final output is parsed and
validated locally before it is returned.
