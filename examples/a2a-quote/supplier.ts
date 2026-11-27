import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  TaskState,
  type AgentCard,
} from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import { issuer, requestQuoteSchema, supplierAudience, tenantClaim } from './quote';

const requestSchema = z.object({
  method: z.enum(['SendMessage', 'GetTask']),
  params: z.object({ tenant: z.string().min(1) }).passthrough(),
}).passthrough();

// A supplier built with the A2A SDK. Its task store is independent of Fevex.
export function startSupplier(jwks: JSONWebKeySet) {
  const keySet = createLocalJWKSet(jwks);
  const submissions: { operationId: string; taskId: string }[] = [];
  const reads: string[] = [];
  let finishQuotes!: () => void;
  const finish = new Promise<void>((resolve) => { finishQuotes = resolve; });
  const executor: AgentExecutor = {
    async execute({ taskId, contextId, userMessage }, bus) {
      const part = userMessage.parts[0]?.content;
      const input = requestQuoteSchema.parse(part?.$case === 'data' ? part.value : undefined);
      submissions.push({ operationId: userMessage.messageId, taskId });
      bus.publish(AgentEvent.task({
        id: taskId, contextId, artifacts: [], history: [userMessage], metadata: undefined,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
      }));
      await finish;
      bus.publish(AgentEvent.artifactUpdate({
        taskId, contextId, append: false, lastChunk: true, metadata: undefined,
        artifact: {
          artifactId: crypto.randomUUID(), name: 'quote', description: '', extensions: [], metadata: undefined,
          parts: [{
            content: { $case: 'data', value: { ...input, totalCents: 1_250 * input.quantity, currency: 'USD' } },
            metadata: undefined, filename: '', mediaType: 'application/json',
          }],
        },
      }));
      bus.publish(AgentEvent.statusUpdate({
        taskId, contextId, metadata: undefined,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
      }));
    },
    async cancelTask() { throw new Error('The quote fixture only supports SendMessage and GetTask'); },
  };

  let transport: JsonRpcTransportHandler;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/a2a' || request.method !== 'POST') {
        return new Response(null, { status: 404 });
      }
      const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
      if (!token) return new Response(null, { status: 401 });
      const claims = await jwtVerify(token, keySet, {
        issuer,
        audience: supplierAudience,
        algorithms: ['RS256'],
        typ: 'at+jwt',
        requiredClaims: ['sub', 'exp', 'iat', 'jti', 'client_id'],
      }).then(({ payload }) => payload, () => undefined);
      if (!claims?.sub) return new Response(null, { status: 401 });
      if (request.headers.get(A2A_VERSION_HEADER) !== A2A_PROTOCOL_VERSION) {
        return new Response('Use A2A 1.0', { status: 400 });
      }
      const parsed = requestSchema.safeParse(await request.json().catch(() => undefined));
      if (!parsed.success) return new Response(null, { status: 400 });
      const { method, params } = parsed.data;
      const requiredScope = method === 'SendMessage' ? 'quote:request' : 'quote:read';
      const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : [];
      if (params.tenant !== claims[tenantClaim] || !scopes.includes(requiredScope)) {
        return new Response(null, { status: 403 });
      }

      if (method === 'GetTask' && typeof params.id === 'string') reads.push(params.id);
      const response = await transport.handle(parsed.data, new ServerCallContext({
        requestedVersion: A2A_PROTOCOL_VERSION,
        user: { isAuthenticated: true, userName: claims.sub },
      }));
      return Response.json(response);
    },
  });
  const endpoint = new URL('/a2a', server.url);
  const card: AgentCard = {
    name: 'Quote supplier', description: 'Returns synthetic quotes for the A2A example.',
    version: '1.0.0', provider: undefined, signatures: [],
    supportedInterfaces: [{
      url: endpoint.href, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '',
    }],
    capabilities: { extensions: [] }, securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [{
      id: 'quote', name: 'Quote', description: 'Quote an item and quantity.',
      tags: ['quote'], examples: [], inputModes: [], outputModes: [], securityRequirements: [],
    }],
  };
  transport = new JsonRpcTransportHandler(new DefaultRequestHandler(card, new InMemoryTaskStore(), executor));
  return {
    endpoint, finishQuotes, submissions, reads,
    async close() {
      finishQuotes();
      await server.stop(true);
    },
  };
}
