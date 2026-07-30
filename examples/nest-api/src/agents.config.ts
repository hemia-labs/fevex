import { defineAgent, defineTool, defineWorkflow } from '@fevex/core';
import { z } from 'zod';
import {
  capabilityAgentCatalog,
  capabilityAgents,
  capabilityTools,
  connections,
  contextProviders,
  memoryStore,
} from './capability-demos';

const localAgentCatalog = [
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
  {
    name: 'sandbox-code',
    label: 'Sandbox Code',
    description: 'Runs a tiny allowlisted local command through the development sandbox.',
    instructions:
      'Use sandbox_run to evaluate short arithmetic expressions. Explain that this is a local development sandbox, not production isolation.',
  },
];

export const agentCatalog = [...localAgentCatalog, ...capabilityAgentCatalog];

export const workflowCatalog = [
  {
    name: 'support-workflow',
    label: 'Smart Support Workflow',
    description: 'Routes simple account questions to Support and operational questions to Ops.',
  },
  {
    name: 'incident-workflow',
    label: 'Incident Workflow',
    description: 'Runs Support and Ops in parallel, then merges both perspectives.',
  },
  {
    name: 'review-workflow',
    label: 'Durable Review Workflow',
    description: 'Drafts an answer, waits for an external review event, then finalizes it.',
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

const sandboxRunInput = z.object({
  expression: z.string().min(1).max(80).regex(/^[0-9\s+\-*/().]+$/),
});

const sandboxRunOutput = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  timedOut: z.boolean(),
});

const localTools = [
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
    risk: 'write',
    approval: 'required',
    idempotency: 'keyed',
    execute({ accountId, severity }, context) {
      return {
        escalationId: `ESC-${accountId}-${context.idempotencyKey}`,
        accountId,
        severity,
        etaMinutes: severity === 'critical' ? 15 : severity === 'high' ? 30 : 60,
      };
    },
  }),
  defineTool({
    name: 'sandbox_run',
    description: 'Evaluate a short arithmetic expression with an allowlisted local process.',
    inputSchema: sandboxRunInput,
    outputSchema: sandboxRunOutput,
    sandbox: {
      process: { commands: [process.execPath], timeoutMs: 1_000 },
      filesystem: { cwd: '.' },
      network: false,
      resources: { timeoutMs: 1_000, maxOutputBytes: 2_048 },
    },
    async execute({ expression }, context) {
      const result = await context.sandbox!.run({
        command: process.execPath,
        args: ['-e', `console.log(${expression.trim()})`],
        cwd: '.',
      });
      return {
        ...result,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    },
  }),
];

export const tools = [...localTools, ...capabilityTools];

export const agents = [
  ...localAgentCatalog.map(({ name, instructions }) => defineAgent({
    name,
    instructions,
    tools:
      name === 'support'
        ? ['accounts_get']
        : name === 'sandbox-code'
          ? ['sandbox_run']
        : localTools.map((tool) => tool.name),
  })),
  ...capabilityAgents,
];

export { connections, contextProviders, memoryStore };

function routeToOps(input: unknown) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return /\b(incident|latency|error|uptime|ticket|escalat|critical|ops|health)\b/i.test(text);
}

export const workflows = [
  defineWorkflow({
    name: 'support-workflow',
    version: '1',
    outputSchema: z.string(),
    async run(step, input) {
      return (
        await step.agent('route', routeToOps(input) ? 'ops' : 'support', {
          input,
        })
      ).output;
    },
  }),
  defineWorkflow({
    name: 'incident-workflow',
    version: '1',
    outputSchema: z.string(),
    async run(step, input) {
      const research = await step.parallel('research', {
        support: () => step.agent('support', 'support', { input }),
        ops: () => step.agent('ops', 'ops', { input }),
      });

      return (
        await step.agent('merge', 'ops', {
          input: {
            request: input,
            support: research.support.output,
            ops: research.ops.output,
            instruction:
              'Merge both findings into a concise incident briefing with status, evidence and next actions.',
          },
        })
      ).output;
    },
  }),
  defineWorkflow({
    name: 'review-workflow',
    version: '1',
    limits: { maxSteps: 6, maxToolCalls: 8 },
    outputSchema: z.string(),
    events: {
      'review.approved': {
        payloadSchema: z.object({
          approved: z.literal(true),
          comment: z.string().optional(),
        }),
        requireActor: true,
      },
    },
    async run(step, input) {
      const draft = await step.agent('draft', 'support', { input });
      const review = await step.waitForEvent('review', 'review.approved');

      return (
        await step.agent('final', 'ops', {
          input: {
            request: input,
            draft: draft.output,
            review: review.payload,
            reviewer: review.actor,
            reviewedAt: review.receivedAt,
            instruction:
              'Finalize the reviewed support answer. Mention that the external review event was received.',
          },
        })
      ).output;
    },
  }),
];
