import { describe, expect, test } from 'bun:test';
import type { TokenVerifier } from '../claims';
import { extractBearerToken, verifyBearerToken } from './index';

const identity = {
  actor: { id: 'alice' },
  scopes: [],
};

describe('bearer credentials', () => {
  test('extracts a case-insensitive bearer token', () => {
    expect(extractBearerToken('Bearer abc.def')).toBe('abc.def');
    expect(extractBearerToken('bearer   abc')).toBe('abc');
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('Bearer a b')).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  test('verifies the header through a token verifier', async () => {
    const seen: string[] = [];
    const verifier: TokenVerifier = {
      async verify(token) {
        seen.push(token);
        return identity;
      },
    };

    expect(await verifyBearerToken(verifier, 'Bearer abc')).toBe(identity);
    expect(seen).toEqual(['abc']);
    await expect(verifyBearerToken(verifier, 'Basic abc')).rejects.toMatchObject({
      code: 'IDENTITY_INVALID',
    });
  });
});
