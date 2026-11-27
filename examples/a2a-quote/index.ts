import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER } from '@a2a-js/sdk';
import { FevexRunError } from '@fevex/core';
import { createJwtVerifier } from '@fevex/core/identity/oauth';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { openBuyer } from './buyer';
import { buyerAudience, issuer, supplierAudience, tenantClaim } from './quote';
import { startSupplier } from './supplier';

export async function runDemo() {
  const tenant = 'quote-pilot';
  const buyer = 'buyer-1';
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwks = { keys: [{ ...await exportJWK(publicKey), kid: 'quote-demo' }] };
  const issue = (audience: string, scope: string, subject = buyer, tenantId = tenant) =>
    new SignJWT({ client_id: 'quote-demo', scope, [tenantClaim]: tenantId })
      .setProtectedHeader({ alg: 'RS256', kid: 'quote-demo', typ: 'at+jwt' })
      .setIssuer(issuer).setAudience(audience).setSubject(subject)
      .setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime('5m')
      .sign(privateKey);
  const [buyerToken, supplierToken, otherTenantToken, otherSupplierBuyerToken] = await Promise.all([
    issue(buyerAudience, 'quote:request quote:resume'),
    issue(supplierAudience, 'quote:request quote:read'),
    issue(buyerAudience, 'quote:resume', buyer, 'other-tenant'),
    issue(supplierAudience, 'quote:read', 'buyer-2'),
  ]);
  const authorization = `Bearer ${buyerToken}`;
  const directory = mkdtempSync(join(tmpdir(), 'fevex-a2a-quote-'));
  const supplier = startSupplier(jwks);
  const buyerOptions: Parameters<typeof openBuyer>[0] = {
    directory,
    endpoint: supplier.endpoint,
    verifier: createJwtVerifier({ issuer, audience: buyerAudience, jwks }),
    supplierToken(identity) {
      assert.equal(identity.actor.id, buyer);
      assert.equal(identity.tenant, tenant);
      return supplierToken;
    },
  };
  const quoteRequest = { sku: 'WIDGET-42', quantity: 2 };
  try {
    const first = openBuyer(buyerOptions);
    const { run, operation } = await (async () => {
      try {
        const started = await first.startQuote(quoteRequest, authorization);
        const run = await first.wait(started.id);
        assert(run);
        assert.equal(run.status, 'paused', run.error ?? '');
        assert.equal(run.pause?.type, 'elicitation');
        const operation = first.getOperation(run.id);
        assert(operation?.taskId && operation.contextId);
        assert.equal(operation.toolCallId, 'request-quote');
        assert.deepEqual(supplier.submissions, [{ operationId: operation.operationId, taskId: operation.taskId }]);
        return { run, operation };
      } finally {
        await first.close();
      }
    })();

    const second = openBuyer(buyerOptions);
    const duplicate = openBuyer(buyerOptions);
    try {
      assert.deepEqual(second.getOperation(run.id), operation);
      await assert.rejects(
        () => second.reconnect(run.id, `Bearer ${otherTenantToken}`),
        /Quote resume is not authorized/,
      );
      assert.equal(supplier.reads.length, 0);
      assert.equal(await second.reconnect(run.id, authorization), 'pending');
      assert.equal((await second.wait(run.id))?.status, 'paused');

      async function getTask(token: string) {
        const response = await fetch(supplier.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id: crypto.randomUUID(), method: 'GetTask',
            params: { id: operation.taskId, tenant },
          }),
          signal: AbortSignal.timeout(1_000),
        });
        if (!response.ok) return { httpStatus: response.status };
        return await response.json() as { result?: { status: { state: string } }; error?: unknown };
      }

      assert.deepEqual(await getTask(buyerToken), { httpStatus: 401 });
      const foreignRead = await getTask(otherSupplierBuyerToken);
      assert('error' in foreignRead && foreignRead.error);

      supplier.finishQuotes();
      const deadline = Date.now() + 5_000;
      while (true) {
        const task = await getTask(supplierToken);
        if ('result' in task && task.result?.status.state === 'TASK_STATE_COMPLETED') break;
        assert(Date.now() < deadline, 'Supplier task did not complete');
        await Bun.sleep(10);
      }

      const reconnectors = [second, duplicate];
      const race = await Promise.allSettled(reconnectors.map((client) => client.reconnect(run.id, authorization)));
      const winnerIndex = race.findIndex((attempt) => attempt.status === 'fulfilled' && attempt.value === 'resumed');
      assert(winnerIndex >= 0, `Neither reconnect resumed the run: ${race.map((attempt) =>
        attempt.status === 'rejected' ? String(attempt.reason) : attempt.value).join(', ')}`);
      const loser = race[1 - winnerIndex];
      assert(loser.status === 'rejected');
      assert(
        (loser.reason instanceof FevexRunError && (
          ['RUN_CONFLICT', 'RUN_NOT_RESUMABLE'].includes(loser.reason.code)
          || (loser.reason.code === 'ELICITATION_INVALID' && loser.reason.message === 'Elicitation does not match the run')
        ))
          || (loser.reason instanceof Error && loser.reason.message === 'Quote run is not awaiting a supplier result'),
        String(loser.reason),
      );
      const final = await reconnectors[winnerIndex].wait(run.id);
      assert(final);
      assert.equal(final.id, run.id);
      assert.equal(final.status, 'completed', final.error ?? '');
      assert.deepEqual(final.output, { ...quoteRequest, totalCents: 2_500, currency: 'USD' });

      const events = await second.events(run.id);
      for (const type of ['run.started', 'elicitation.resolved', 'run.resumed', 'run.completed']) {
        assert.equal(events.filter((event) => event.type === type).length, 1, type);
      }
      assert.equal(events.filter((event) => event.type === 'tool.completed'
        && event.payload.toolCallId === operation.toolCallId).length, 1);
      assert.deepEqual(supplier.submissions, [{ operationId: operation.operationId, taskId: operation.taskId }]);
      assert(supplier.reads.length >= 4 && supplier.reads.every((taskId) => taskId === operation.taskId));
      return {
        runId: final.id, operationId: operation.operationId, toolCallId: operation.toolCallId,
        taskId: operation.taskId, contextId: operation.contextId,
        submissions: supplier.submissions.length,
        resumptions: events.filter((event) => event.type === 'run.resumed').length,
        quote: final.output,
      };
    } finally {
      await Promise.all([second.close(), duplicate.close()]);
    }
  } finally {
    await supplier.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) console.log(JSON.stringify(await runDemo(), null, 2));
