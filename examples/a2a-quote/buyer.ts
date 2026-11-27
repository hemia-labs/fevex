import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER } from '@a2a-js/sdk';
import { createFevex, defineAgent, defineTool, type AgentIdentity, type JsonObject } from '@fevex/core';
import { verifyBearerToken, type TokenVerifier } from '@fevex/core/identity/oauth';
import type { ModelGateway } from '@fevex/core/models';
import { createSQLiteRunStore } from '@fevex/sqlite';
import { z } from 'zod';
import { quoteSchema, requestQuoteSchema, type QuoteRequest } from './quote';

const requestCallId = 'request-quote';
const waitCallId = 'wait-for-quote';
const { $schema: _dialect, ...responseSchema } = z.toJSONSchema(quoteSchema);
const taskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1),
  status: z.object({ state: z.string() }),
  artifacts: z.array(z.object({ name: z.string(), parts: z.array(z.object({ data: z.unknown() })) })).optional(),
});
type Operation = QuoteRequest & {
  runId: string;
  toolCallId: string;
  operationId: string;
  actor: string;
  tenant: string;
  endpoint: string;
  taskId: string | null;
  contextId: string | null;
};

// A stateless fixture makes the reconnect independent of any in-memory model transcript.
const model: ModelGateway = {
  async *stream({ messages }) {
    const resolved = messages.find(({ role, toolCallId }) => role === 'tool' && toolCallId === waitCallId);
    if (resolved) {
      const output = quoteSchema.parse(JSON.parse(resolved.content));
      yield { type: 'output.delta', delta: JSON.stringify(output) };
      yield { type: 'completed', result: { output } };
      return;
    }
    const submitted = messages.some(({ role, toolCallId }) => role === 'tool' && toolCallId === requestCallId);
    if (submitted) {
      yield { type: 'completed', result: { toolCalls: [{
        id: waitCallId,
        name: 'fevex__elicit',
        input: { prompt: 'Wait for the completed supplier quote.', responseSchema: responseSchema as JsonObject },
      }] } };
      return;
    }
    const input = requestQuoteSchema.parse(JSON.parse(messages.find(({ role }) => role === 'user')!.content));
    yield { type: 'completed', result: { toolCalls: [{ id: requestCallId, name: 'request_quote', input }] } };
  },
};

interface BuyerOptions {
  directory: string;
  endpoint: URL;
  verifier: TokenVerifier;
  supplierToken(identity: AgentIdentity): string;
}

export function openBuyer({ directory, endpoint, verifier, supplierToken }: BuyerOptions) {
  const runStore = createSQLiteRunStore({ filename: join(directory, 'runs.sqlite') });
  const operations = new Database(join(directory, 'operations.sqlite'), { strict: true });
  operations.run(`CREATE TABLE IF NOT EXISTS quote_operations (
    runId TEXT PRIMARY KEY, toolCallId TEXT NOT NULL, operationId TEXT NOT NULL UNIQUE,
    actor TEXT NOT NULL, tenant TEXT NOT NULL, endpoint TEXT NOT NULL,
    sku TEXT NOT NULL, quantity INTEGER NOT NULL, taskId TEXT, contextId TEXT
  ) STRICT`);
  const byRun = operations.query<Operation, [string]>('SELECT * FROM quote_operations WHERE runId = ?');

  async function rpc(identity: AgentIdentity, method: 'SendMessage' | 'GetTask', params: object, signal?: AbortSignal) {
    const id = crypto.randomUUID();
    const timeout = AbortSignal.timeout(5_000);
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supplierToken(identity)}`,
        [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, tenant: identity.tenant } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Supplier ${method} returned HTTP ${response.status}`);
    const envelope = z.object({
      jsonrpc: z.literal('2.0'), id: z.literal(id), result: z.unknown(), error: z.unknown().optional(),
    }).parse(await response.json());
    if (envelope.error !== undefined) throw new Error(`Supplier rejected ${method}`);
    return envelope.result;
  }

  const app = createFevex({
    models: { default: model },
    runStore,
    agents: [defineAgent({
      name: 'quote-buyer', instructions: 'Ask the supplier for a quote and wait for the result.',
      tools: ['request_quote'], elicitation: 'pause', limits: { maxSteps: 4, maxToolCalls: 2 },
    })],
    tools: [defineTool({
      name: 'request_quote', description: 'Submit a quote to the configured supplier.',
      inputSchema: requestQuoteSchema, risk: 'write',
      async execute(input, context) {
        const identity = context.context?.identity;
        if (!identity?.tenant || !identity.scopes.includes('quote:request')) {
          throw new Error('Quote request is not authorized');
        }
        // Reserve the operation before I/O. A second insert for this run will not send a second request.
        operations.run(
          `INSERT INTO quote_operations
           (runId, toolCallId, operationId, actor, tenant, endpoint, sku, quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [context.runId, context.toolCallId, context.idempotencyKey, identity.actor.id,
            identity.tenant, endpoint.href, input.sku, input.quantity],
        );
        const response = await rpc(identity, 'SendMessage', {
          message: { messageId: context.idempotencyKey, role: 'ROLE_USER', parts: [{ data: input }] },
          configuration: { returnImmediately: true },
        }, context.signal);
        const { task } = z.object({ task: taskSchema }).parse(response);
        operations.run('UPDATE quote_operations SET taskId = ?, contextId = ? WHERE operationId = ?',
          [task.id, task.contextId, context.idempotencyKey]);
        return { taskId: task.id, contextId: task.contextId };
      },
    })],
  });

  return {
    async startQuote(input: QuoteRequest, authorization: string) {
      const identity = await verifyBearerToken(verifier, authorization);
      if (!identity.tenant || !identity.scopes.includes('quote:request')) {
        throw new Error('Quote request is not authorized');
      }
      return app.startAgent('quote-buyer', {
        input: JSON.stringify(requestQuoteSchema.parse(input)), context: { identity },
      });
    },
    async reconnect(runId: string, authorization: string) {
      const identity = await verifyBearerToken(verifier, authorization);
      const operation = byRun.get(runId);
      if (!operation || operation.actor !== identity.actor.id || operation.tenant !== identity.tenant
        || !identity.scopes.includes('quote:resume')) {
        throw new Error('Quote resume is not authorized');
      }
      if (!operation.taskId || !operation.contextId || operation.endpoint !== endpoint.href) {
        throw new Error('The supplier task reference requires reconciliation');
      }
      const run = await app.getRun(runId);
      if (run?.status !== 'paused' || run.pause?.type !== 'elicitation' || run.pause.request.toolCallId !== waitCallId) {
        throw new Error('Quote run is not awaiting a supplier result');
      }
      const task = taskSchema.parse(await rpc(identity, 'GetTask', { id: operation.taskId }));
      if (task.id !== operation.taskId || task.contextId !== operation.contextId) {
        throw new Error('The supplier returned a different task or context');
      }
      if (task.status.state === 'TASK_STATE_SUBMITTED' || task.status.state === 'TASK_STATE_WORKING') return 'pending';
      if (task.status.state !== 'TASK_STATE_COMPLETED') throw new Error(`Supplier task is ${task.status.state}`);
      const quote = quoteSchema.parse(task.artifacts?.find(({ name }) => name === 'quote')?.parts[0]?.data);
      if (quote.sku !== operation.sku || quote.quantity !== operation.quantity) {
        throw new Error('The supplier quote does not match the requested item and quantity');
      }
      await app.resumeRun(runId, {
        type: 'elicitation', requestId: run.pause.request.id, value: quote, actor: identity.actor,
      });
      return 'resumed';
    },
    getOperation: (runId: string) => byRun.get(runId),
    wait: (runId: string) => app.waitForRun(runId, { timeoutMs: 5_000 }),
    events: (runId: string) => app.listEvents(runId),
    async close() {
      try {
        await app.shutdown({ timeoutMs: 5_000 });
      } finally {
        operations.close();
        await runStore.close();
      }
    },
  };
}
