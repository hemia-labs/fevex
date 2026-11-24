---
"@fevex/core": minor
---

Add inbound OAuth token verification.

`@fevex/core/identity/oauth` now verifies RFC 9068 JWT access tokens with the
issuer's JWKS (`jose`) and RFC 7662 opaque tokens through introspection. Both
backends build the same `AgentIdentity` and enforce token type, issuer,
audience and expiry, while preserving the delegated agent (`act`) and tenant.

New exports:

- `createJwtVerifier` and `createIntrospectionVerifier`.
- `TokenVerifier`, `identityFromClaims`, `extractBearerToken` and
  `verifyBearerToken`.
- `IDENTITY_UNAVAILABLE` for issuers that cannot be reached.

Scopes are now validated against the RFC 6749 `scope-token` grammar.

`jose` is a new dependency, imported only by `@fevex/core/identity/oauth`.
