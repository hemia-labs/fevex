import { createFevexHttpClient } from '@fevex/core/http/client';

export const apiBaseUrl = (
  process.env.NEXT_PUBLIC_FEVEX_API_URL ?? 'http://127.0.0.1:3001'
).replace(/\/$/, '');

export const tokenStorageKey = 'fevex.studio.token';

export function storedToken(): string | undefined {
  if (typeof window === 'undefined') return process.env.NEXT_PUBLIC_FEVEX_API_TOKEN;
  return window.localStorage.getItem(tokenStorageKey)
    ?? process.env.NEXT_PUBLIC_FEVEX_API_TOKEN
    ?? undefined;
}

export function saveToken(value: string): void {
  if (typeof window === 'undefined') return;
  const token = value.trim();
  if (token) window.localStorage.setItem(tokenStorageKey, token);
  else window.localStorage.removeItem(tokenStorageKey);
}

export function createStudioClient() {
  const token = storedToken();
  return createFevexHttpClient({
    baseUrl: apiBaseUrl,
    fetch: (input, init) => {
      if (!token) return fetch(input, init);
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
  });
}
