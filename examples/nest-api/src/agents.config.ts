import { defineAgent, defineTool } from '@fevex/core';
import { z } from 'zod';

export const agentCatalog = [
  {
    name: 'support',
    label: 'Support',
    description: 'Answers account questions using tools.',
    instructions:
      'Answer account questions clearly. Use tools when account data is needed. When showing account data from accounts_get, respond with a Markdown table using the columns Campo and Valor.',
  },
  {
    name: 'ops',
    label: 'Ops Triage',
    description: 'Investigates account health using account, tickets, metrics and incidents tools.',
    instructions:
      'You are an operations triage agent. Investigate the account before answering: get the account, recent tickets, service metrics and open incidents when relevant. Present findings in Markdown with a short status, tables for data, and clear next actions. Only create an escalation when the user asks you to escalate or when there is an open critical incident.',
  },
];

const accountInput = z.object({
  accountId: z.number(),
});

const accountOutput = z.object({
  accountId: z.number(),
  status: z.enum(['active', 'paused']),
  plan: z.enum(['free', 'pro']),
});

const ticketsOutput = z.object({
  accountId: z.number(),
  tickets: z.array(
    z.object({
      id: z.string(),
      priority: z.enum(['low', 'medium', 'high']),
      status: z.enum(['open', 'pending', 'closed']),
      title: z.string(),
    }),
  ),
});

const metricsOutput = z.object({
  accountId: z.number(),
  period: z.enum(['1h', '24h', '7d']),
  uptimePercent: z.number(),
  p95LatencyMs: z.number(),
  errorRatePercent: z.number(),
});

const incidentsOutput = z.object({
  accountId: z.number(),
  incidents: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['minor', 'major', 'critical']),
      service: z.string(),
      status: z.enum(['investigating', 'mitigated', 'resolved']),
    }),
  ),
});

const escalationInput = z.object({
  accountId: z.number(),
  reason: z.string(),
  severity: z.enum(['medium', 'high', 'critical']),
});

const escalationOutput = z.object({
  escalationId: z.string(),
  accountId: z.number(),
  severity: z.enum(['medium', 'high', 'critical']),
  etaMinutes: z.number(),
});

export const tools = [
  defineTool({
    name: 'accounts_get',
    description: 'Get account status and plan by ID.',
    inputSchema: accountInput,
    outputSchema: accountOutput,
    execute({ accountId }) {
      return {
        accountId,
        status: accountId % 2 === 0 ? 'active' : 'paused',
        plan: accountId % 3 === 0 ? 'pro' : 'free',
      };
    },
  }),
  defineTool({
    name: 'tickets_recent',
    description: 'List recent support tickets for an account.',
    inputSchema: accountInput,
    outputSchema: ticketsOutput,
    execute({ accountId }) {
      return {
        accountId,
        tickets: [
          {
            id: `T-${accountId}-101`,
            priority: accountId % 2 === 0 ? 'medium' : 'high',
            status: 'open',
            title: 'Intermittent API timeout reports',
          },
          {
            id: `T-${accountId}-087`,
            priority: 'low',
            status: 'closed',
            title: 'Billing contact update',
          },
        ],
      };
    },
  }),
  defineTool({
    name: 'metrics_get',
    description: 'Get account service metrics for a recent period.',
    inputSchema: z.object({
      accountId: z.number(),
      period: z.enum(['1h', '24h', '7d']).default('24h'),
    }),
    outputSchema: metricsOutput,
    execute({ accountId, period }) {
      return {
        accountId,
        period,
        uptimePercent: accountId % 5 === 0 ? 97.8 : 99.95,
        p95LatencyMs: accountId % 5 === 0 ? 1420 : 180,
        errorRatePercent: accountId % 5 === 0 ? 3.2 : 0.08,
      };
    },
  }),
  defineTool({
    name: 'incidents_open',
    description: 'List open incidents that may affect an account.',
    inputSchema: accountInput,
    outputSchema: incidentsOutput,
    execute({ accountId }) {
      return {
        accountId,
        incidents:
          accountId % 5 === 0
            ? [
                {
                  id: `INC-${accountId}-9`,
                  severity: 'critical',
                  service: 'API Gateway',
                  status: 'investigating',
                },
              ]
            : [],
      };
    },
  }),
  defineTool({
    name: 'escalations_create',
    description: 'Create an operations escalation for an account.',
    inputSchema: escalationInput,
    outputSchema: escalationOutput,
    execute({ accountId, severity }) {
      return {
        escalationId: `ESC-${accountId}-${Date.now()}`,
        accountId,
        severity,
        etaMinutes: severity === 'critical' ? 15 : severity === 'high' ? 30 : 60,
      };
    },
  }),
];

export const agents = agentCatalog.map(({ name, instructions }) => defineAgent({
  name,
  instructions,
  tools:
    name === 'support'
      ? ['accounts_get']
      : tools.map((tool) => tool.name),
}));
