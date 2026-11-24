import { describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { defineAgent } from '../../agents';
import { createFevex } from '../../fevex';
import { createFevexHttpHandler } from '../../http';
import { fakeModel } from '../../testing';
import { createJwtVerifier, verifyBearerToken } from './index';

const issuer = 'https://idp.test';
const audience = 'https://fevex.test';
const now = Math.floor(Date.now() / 1000);

async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const verifier = createJwtVerifier({
    issuer,
    audience,
    jwks: { keys: [{ ...jwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] },
  });
  const app = createFevex({
    models: { default: fakeModel({ output: 'ok' }) },
    agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
  });
  const handler = createFevexHttpHandler({ fevex: app });
  const authenticated = async (request: Request) => {
    const identity = await verifyBearerToken(
      verifier,
      request.headers.get('authorization'),
    );
    return handler(request, { context: { identity } });
  };

  const sign = (aud: string) =>
    new SignJWT({ scope: 'repo:read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(aud)
      .setSubject('alice')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);

  return { authenticated, sign };
}

describe('inbound token adapter', () => {
  test('starts a run with a verified bearer credential', async () => {
    const { authenticated, sign } = await fixture();
    const response = await authenticated(new Request('http://local/v1/agents/assistant/runs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await sign(audience)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: 'hello' }),
    }));

    expect(response.status).toBe(202);
    const run = await response.json() as { agentName: string; status: string };
    expect(run.agentName).toBe('assistant');
  });

  test('rejects a credential issued for another resource', async () => {
    const { authenticated, sign } = await fixture();
    await expect(authenticated(new Request('http://local/v1/agents/assistant/runs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await sign('https://other.test')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: 'hello' }),
    }))).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });
});
