/**
 * OAuth scope tokens follow the `scope-token` grammar of RFC 6749 §3.3:
 * `%x21 / %x23-5B / %x5D-7E` (printable ASCII except space, quote and
 * backslash).
 */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** Normalizes scopes: trims, validates, drops duplicates and rejects empty entries. */
export function normalizeScopes(scopes: readonly string[]): string[] {
  const normalized = scopes.map((scope) => {
    if (typeof scope !== 'string' || !scope.trim()) {
      throw new TypeError('Identity scopes must be non-empty strings');
    }
    const trimmed = scope.trim();
    if (!SCOPE_TOKEN.test(trimmed)) {
      throw new TypeError(`Identity scope "${trimmed}" is not a valid RFC 6749 scope token`);
    }
    return trimmed;
  });
  return [...new Set(normalized)];
}

export function hasScope(identity: { scopes: readonly string[] }, scope: string): boolean {
  return identity.scopes.includes(scope);
}

/** True when every child scope exists in the parent identity. */
export function isScopeSubset(
  child: readonly string[],
  parent: readonly string[],
): boolean {
  const allowed = new Set(parent);
  return child.every((scope) => allowed.has(scope));
}
