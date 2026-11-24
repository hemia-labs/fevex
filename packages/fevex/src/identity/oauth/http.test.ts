import { describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { defineAgent } from '../../agents';
import type { ExecutionContext } from '../../core';
import { createFevex } from '../../fevex';
import { createFevexHttpHandler } from '../../http';
import { FevexRunError } from '../../run-error';
import { fakeModel } from '../../testing';
import { createJwtVerifier, verifyBearerToken, type TokenVerifier } from './index';

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
    models: {
      default: fakeModel(
        { output: 'ok' },
        { output: 'ok' },
        { output: 'ok' },
        { output: 'ok' },
      ),
    },
    agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
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

  const authenticatedWith = (tokenVerifier: TokenVerifier) => async (request: Request) => {
    try {
      const identity = await verifyBearerToken(
        tokenVerifier,
        request.headers.get('authorization'),
      );
      return await handler(request, { context: { identity } });
    } catch (error) {
      if (error instanceof FevexRunError && error.code === 'IDENTITY_UNAVAILABLE') {
        return new Response(JSON.stringify({ code: error.code }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '5' },
        });
      }
      if (error instanceof FevexRunError) {
        return new Response(JSON.stringify({ code: error.code }), {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer error="invalid_token"',
          },
        });
      }
      throw error;
    }
  };

  const sign = (overrides: {
    audience?: string;
    subject?: string;
    tenant?: string;
  } = {}) =>
    new SignJWT({
      client_id: 'fevex-host',
      jti: crypto.randomUUID(),
      scope: 'repo:read',
      'https://fevex.dev/tenant': overrides.tenant ?? 'tenant-a',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(overrides.audience ?? audience)
      .setSubject(overrides.subject ?? 'alice')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);

  return { authenticatedWith, sign, verifier };
}

function startRequest(token: string, sessionId?: string) {
  return new Request('http://local/v1/agents/assistant/runs', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ input: 'hello', ...(sessionId ? { sessionId } : {}) }),
  });
}

describe('inbound token adapter', () => {
  test('starts a run with a verified bearer credential', async () => {
    const { authenticatedWith, sign, verifier } = await fixture();
    const response = await authenticatedWith(verifier)(startRequest(await sign()));
    expect(response.status).toBe(202);
    const run = await response.json() as { agentName: string; status: string };
    expect(run.agentName).toBe('assistant');
  });

  test('authorizes run access by tenant and actor', async () => {
    const { authenticatedWith, sign, verifier } = await fixture();
    const authenticated = authenticatedWith(verifier);

    const started = await authenticated(startRequest(await sign()));
    expect(started.status).toBe(202);
    const run = await started.json() as { id: string };

    const own = await authenticated(new Request(`http://local/v1/runs/${run.id}`, {
      headers: { authorization: `Bearer ${await sign()}` },
    }));
    expect(own.status).toBe(200);

    const otherActor = await authenticated(new Request(`http://local/v1/runs/${run.id}`, {
      headers: {
        authorization: `Bearer ${await sign({ subject: 'bob', tenant: 'tenant-a' })}`,
      },
    }));
    expect(otherActor.status).toBe(403);

    // Same actor, different tenant: the run belongs to (tenant-a, alice).
    const otherTenant = await authenticated(new Request(`http://local/v1/runs/${run.id}`, {
      headers: {
        authorization: `Bearer ${await sign({ subject: 'alice', tenant: 'tenant-b' })}`,
      },
    }));
    expect(otherTenant.status).toBe(403);
  });

  test('authorizes session reuse by tenant and actor', async () => {
    const { authenticatedWith, sign, verifier } = await fixture();
    const authenticated = authenticatedWith(verifier);

    const started = await authenticated(startRequest(await sign()));
    expect(started.status).toBe(202);
    const run = await started.json() as { sessionId: string };

    const own = await authenticated(startRequest(await sign(), run.sessionId));
    expect(own.status).toBe(202);

    const otherTenant = await authenticated(startRequest(
      await sign({ subject: 'alice', tenant: 'tenant-b' }),
      run.sessionId,
    ));
    expect(otherTenant.status).toBe(403);

    const otherActor = await authenticated(startRequest(
      await sign({ subject: 'bob', tenant: 'tenant-a' }),
      run.sessionId,
    ));
    expect(otherActor.status).toBe(403);
  });

  test('returns 401 with a bearer challenge for an invalid credential', async () => {
    const { authenticatedWith, sign, verifier } = await fixture();
    const response = await authenticatedWith(verifier)(
      startRequest(await sign({ audience: 'https://other.test' })),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });

  test('returns 503 when JWKS retrieval is unavailable', async () => {
    const { authenticatedWith, sign } = await fixture();
    const unavailable = createJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://idp.test/jwks',
      fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
    });

    const response = await authenticatedWith(unavailable)(startRequest(await sign()));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  test('returns 503 when JWKS returns an invalid document', async () => {
    const { authenticatedWith, sign } = await fixture();
    const invalid = createJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://idp.test/jwks',
      fetch: (async () => new Response('<html>maintenance</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch,
    });

    const response = await authenticatedWith(invalid)(startRequest(await sign()));
    expect(response.status).toBe(503);
  });
});
