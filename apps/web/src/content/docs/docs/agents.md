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
an authorization server. Authentication is not authorization: pass the identity
to the runtime **and** enforce run ownership or tenant boundaries in the HTTP
handler. Store both the tenant and the actor for each run; comparing only
`actor.id` lets the same person read a run created under another tenant. The
same check applies when a run reuses an existing session, because its history
becomes part of the new run. Sessions created outside the handler have no owner
record and are denied by default. Persist these ownership records in production;
the in-memory maps only work for a single process.

```ts
import { FevexRunError, type ExecutionContext } from '@fevex/core';
import { createFevexHttpHandler } from '@fevex/core/http';
import { createJwtVerifier, verifyBearerToken } from '@fevex/core/identity/oauth';

const verifier = createJwtVerifier({
  issuer: 'https://idp.example.com',
  audience: 'https://api.example.com',
  jwksUri: 'https://idp.example.com/.well-known/jwks.json',
});

type Owner = { actorId: string; tenant?: string };

const runOwners = new Map<string, Owner>();
const sessionOwners = new Map<string, Owner>();

const owns = (owner: Owner | undefined, identity: ExecutionContext['identity']) =>
  owner !== undefined &&
  owner.actorId === identity?.actor.id &&
  owner.tenant === identity?.tenant;

const handler = createFevexHttpHandler({
  fevex: app,
  authorize(access) {
    const identity = access.context?.identity;
    if (!identity) return false;
    if (access.action === 'start') {
      // A new session has no owner yet. Reusing a session requires the same
      // tenant and actor because its history becomes part of the new run.
      return access.sessionId === undefined ||
        owns(sessionOwners.get(access.sessionId), identity);
    }
    return owns(runOwners.get(access.runId), identity);
  },
  onRunStarted(run, context) {
    const identity = context?.identity;
    if (!identity) return;
    const owner = {
      actorId: identity.actor.id,
      ...(identity.tenant === undefined ? {} : { tenant: identity.tenant }),
    };
    runOwners.set(run.id, owner);
    sessionOwners.set(run.sessionId, owner);
  },
});

export async function authenticated(request: Request) {
  try {
    const identity = await verifyBearerToken(
      verifier,
      request.headers.get('authorization'),
    );
    return await handler(request, { context: { identity } });
  } catch (error) {
    if (error instanceof FevexRunError && error.code === 'IDENTITY_UNAVAILABLE') {
      return Response.json({ code: error.code }, {
        status: 503,
        headers: { 'retry-after': '5' },
      });
    }
    if (error instanceof FevexRunError) {
      return Response.json({ code: error.code }, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
      });
    }
    throw error;
  }
}
```

The JWT backend verifies the signature with the issuer's keys, requires
`typ: at+jwt` (RFC 9068), an exact `iss`, the configured resource in `aud`, a
mandatory `exp`, and the RFC 9068 registered claims `client_id`, `iat` and
`jti`. Set `requireRegisteredClaims: false` only for issuers that do not emit
them. It maps `sub` to the actor, `act.sub` to the delegated agent, a namespaced
claim or `tid` to the tenant, and `scope` to the scope set. The `scope` value
must follow the RFC 6749 §3.3 space-delimited syntax; an empty string is treated
as no scopes for issuer compatibility. Set `tenantClaims` or `agentClaim` when
the issuer uses other claim names.

For opaque tokens, use `createIntrospectionVerifier` with the RFC 7662 endpoint
and client credentials. By default the response must include the configured
resource in `aud` and `token_type: Bearer`. Set `trustIntrospectionEndpoint`
only when the endpoint is resource-specific and guaranteed to return access
tokens.

Both endpoints must use HTTPS; loopback HTTP is accepted for local development.
Redirects are rejected, and the timeout covers the response body, not just the
headers. Both backends fail closed with `IDENTITY_INVALID`, `IDENTITY_EXPIRED`,
or `IDENTITY_UNAVAILABLE` when the issuer cannot be reached or returns a JWKS
document that is not valid JSON. Clock skew defaults to 60 seconds, and only
asymmetric algorithms (`RS256`, `PS256`, `ES256`, `EdDSA`) are accepted.

## Run an agent

```ts
const result = await app.runAgent('support', {
  input: 'What is the status of account 42?',
});
```

The run executes a bounded multi-step model-tool loop with sequential tool
execution. When `outputSchema` is present, the final output is parsed and
validated locally before it is returned.
