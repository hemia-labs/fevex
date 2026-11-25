---
"@fevex/core": minor
---

Harden the inbound OAuth token verifier.

- Require HTTPS for JWKS and introspection endpoints; loopback HTTP remains
  available for local development.
- Reject redirects and keep the introspection timeout active while reading the
  response body. Error response bodies from both JWKS and introspection are
  cancelled before returning.
- Classify a JWKS response with a non-200 status, unreadable body or invalid
  document shape as `IDENTITY_UNAVAILABLE` instead of an invalid token.
- Require the RFC 9068 registered claims `client_id`, `iat` and `jti` by
  default. Use `requireRegisteredClaims: false` only for non-compliant issuers.
- Require `aud` and `token_type: Bearer` in introspection responses by default.
  `trustIntrospectionEndpoint` is the explicit opt-out for resource-specific
  endpoints that guarantee both.
- Encode introspection client credentials with `application/x-www-form-urlencoded`
  before Basic authentication, as required by RFC 6749 §2.3.1.
- Validate `scope` against the RFC 6749 §3.3 list grammar on the raw value:
  arrays, tabs, leading, trailing and repeated spaces are rejected. An empty
  `scope` string is treated as no scopes for issuer compatibility. `scp` keeps
  Azure compatibility.
- Validate that introspection responses are JSON objects with a boolean
  `active` field.
- Document and test run and session ownership by `(tenant, actor.id)` instead of
  actor alone, including session reuse, plus the 401/503 mapping in the inbound
  verification example.
