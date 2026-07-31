import {
  InMemoryMemoryStore,
  defineAgent,
  defineConnection,
  defineContextProvider,
  defineSkill,
  defineTool,
  type JsonObject,
} from '@fevex/core';
import { createMcpToolProvider } from '@fevex/mcp';
import { createOpenApiToolProvider } from '@fevex/openapi';
import { z } from 'zod';

const billingApi = {
  openapi: '3.1.0',
  info: { title: 'Billing Demo', version: '1' },
  servers: [{ url: 'https://billing.demo' }],
  paths: {
    '/invoices/{invoiceId}': {
      get: {
        operationId: 'getInvoice',
        summary: 'Get an invoice by ID',
        parameters: [
          {
            name: 'invoiceId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Invoice' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Invoice: {
        type: 'object',
        properties: {
          invoiceId: { type: 'string' },
          amount: { type: 'number' },
          currency: { enum: ['MXN', 'USD'] },
          status: { enum: ['paid', 'pending'] },
        },
        required: ['invoiceId', 'amount', 'currency', 'status'],
        additionalProperties: false,
      },
    },
  },
} as unknown as JsonObject;

const mcpUrl = `http://localhost:${process.env.MCP_PORT ?? 3002}/mcp`;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

export const connections = [
  defineConnection({
    name: 'billing',
    provider: createOpenApiToolProvider({
      document: billingApi,
      operations: { allow: ['getInvoice'] },
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const invoiceId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        return json({
          invoiceId,
          amount: 1_250,
          currency: 'MXN',
          status: invoiceId.endsWith('0') ? 'paid' : 'pending',
        });
      },
    }),
    allowlist: ['getInvoice'],
  }),
  defineConnection({
    name: 'nest_mcp',
    provider: createMcpToolProvider({ url: mcpUrl }),
    allowlist: ['echo', 'sum', 'multiply', 'slugify', 'word_count'],
  }),
];

const refundTool = defineTool({
  name: 'refund_issue',
  label: 'Emitir reembolso',
  description: 'Issue a demo refund after human approval.',
  inputSchema: z.object({
    accountId: z.number(),
    amount: z.number().positive(),
    reason: z.string(),
  }),
  outputSchema: z.object({
    refundId: z.string(),
    accountId: z.number(),
    amount: z.number(),
    status: z.literal('issued'),
  }),
  risk: 'sensitive',
  approval: 'required',
  idempotency: 'keyed',
  retry: { maxAttempts: 2, backoffMs: 100 },
  execute({ accountId, amount }, context) {
    return {
      refundId: `REF-${context.idempotencyKey}`,
      accountId,
      amount,
      status: 'issued' as const,
    };
  },
});

export const capabilityTools = [refundTool];
export const memoryStore = new InMemoryMemoryStore();
export const contextProviders = [
  defineSkill({
    name: 'support-policy',
    instructions: 'Refunds are allowed up to 30 days after purchase.',
  }),
  defineContextProvider({
    name: 'customer-profile',
    async read({ context }) {
      return [{
        id: 'customer-profile',
        content: `Customer plan: ${String(context?.attributes?.plan ?? 'free')}. Region: ${String(context?.attributes?.region ?? 'MX')}.`,
      }];
    },
  }),
];

export const capabilityAgentCatalog = [
  {
    name: 'mcp-tools',
    label: 'MCP Tools',
    description: 'Usa tools MCP locales para texto y aritmética.',
    instructions: 'Sólo úsalo para echo, suma, multiplicación, slugify y conteo de palabras mediante MCP local.',
    examples: [
      'Convierte "Fevex Durable Runtime" a slug.',
      'Multiplica 12 por 9 usando MCP.',
    ],
  },
  {
    name: 'billing-openapi',
    label: 'Billing OpenAPI',
    description: 'Lee facturas mediante una conexión OpenAPI 3.1.',
    instructions: 'Sólo úsalo para consultar facturas por ID mediante la conexión OpenAPI de billing.',
    examples: [
      'Busca la factura inv_1001.',
      '¿Cuál es el estado de la factura inv_1002?',
    ],
  },
  {
    name: 'refund-approval',
    label: 'Reembolso Aprobado',
    description: 'Pausa operaciones sensibles de reembolso para aprobación humana.',
    instructions: 'Sólo úsalo para emitir reembolsos demo cuando exista cuenta, monto y razón explícitos.',
    examples: [
      'Emite un reembolso para la cuenta 42 por 15 dólares por cobro duplicado.',
      'Reembolsa 30 dólares a la cuenta 25 por crédito de interrupción.',
    ],
  },
  {
    name: 'knowledge-support',
    label: 'Conocimiento y Memoria',
    description: 'Usa policy reutilizable, contexto del cliente y memoria de sesión.',
    instructions: 'Sólo úsalo para soporte de reembolsos usando policy, contexto del cliente y memoria de sesión.',
    examples: [
      '¿Este cliente puede recibir un reembolso?',
      'Recuerda que el cliente prefiere actualizaciones breves.',
    ],
  },
];

export const capabilityAgents = [
  defineAgent({
    name: 'mcp-tools',
    instructions:
      'Only handle simple text and arithmetic tasks supported by nest_mcp: echo, sum, multiply, slugify and word_count. If the request is outside that scope, briefly say this agent only demonstrates those MCP tools. Always use the matching nest_mcp tool; do not answer from memory. The MCP server is local development infrastructure.',
    tools: [
      'nest_mcp__echo',
      'nest_mcp__sum',
      'nest_mcp__multiply',
      'nest_mcp__slugify',
      'nest_mcp__word_count',
    ],
  }),
  defineAgent({
    name: 'billing-openapi',
    instructions:
      'Only answer invoice lookup questions. Ask for an invoice ID when none is provided. Use billing__getInvoice before giving invoice amount, currency or status; do not invent billing data. If the request is not about invoices, briefly say this agent only handles invoice lookups.',
    tools: ['billing__getInvoice'],
  }),
  defineAgent({
    name: 'refund-approval',
    instructions:
      'Only handle demo refund issuance. Use refund_issue only when the user explicitly asks to issue a refund and provides account ID, amount and reason. If any required value is missing, ask for it. If the request is not about issuing a refund, briefly say this agent only handles demo refunds.',
    tools: ['refund_issue'],
  }),
  defineAgent({
    name: 'knowledge-support',
    instructions:
      'Only answer refund-support questions using the supplied policy, customer context and relevant memory. Do not invent account, billing or refund facts not present in context, memory or policy. If the request is outside refund support, briefly say this agent only handles refund support.',
    skills: ['support-policy'],
    context: ['customer-profile'],
    memory: { read: true, write: true, limit: 3 },
  }),
];
