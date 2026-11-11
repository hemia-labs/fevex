---
"@fevex/core": minor
---

Add the `@fevex/core/http/client` subpath. It exports the HTTP client and error
type without the server handler or its Node-only dependencies, so browser
bundles such as the Next playground can import it safely.
