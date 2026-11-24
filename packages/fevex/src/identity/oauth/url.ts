/**
 * Validates an endpoint used by the token verifier.
 *
 * HTTPS is mandatory because these endpoints carry credentials or establish the
 * keys used to trust every token. Loopback HTTP is allowed for local
 * development and tests.
 */
export function secureEndpoint(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }
  if (url.username || url.password) {
    throw new TypeError(`${name} must not include credentials`);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return url;
  throw new TypeError(`${name} must use HTTPS`);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}
