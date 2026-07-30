import type { AgentLimits } from '../agents';
import type { WorkflowBudgetUsage } from '../runtime';
import { addUsage, assertTokenBudget } from './run-support';

function minLimit(
  first: number | false | undefined,
  second: number | false | undefined,
): number | false | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  if (first === false) return second;
  if (second === false) return first;
  return Math.min(first, second);
}

export function combineLimits(
  first: AgentLimits | undefined,
  second: AgentLimits | undefined,
): AgentLimits | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    ...(minLimit(first.maxSteps, second.maxSteps) === undefined
      ? {}
      : { maxSteps: minLimit(first.maxSteps, second.maxSteps) as number }),
    ...(minLimit(first.maxToolCalls, second.maxToolCalls) === undefined
      ? {}
      : { maxToolCalls: minLimit(first.maxToolCalls, second.maxToolCalls) as number }),
    ...(minLimit(first.maxInputTokens, second.maxInputTokens) === undefined
      ? {}
      : { maxInputTokens: minLimit(first.maxInputTokens, second.maxInputTokens) as number | false }),
    ...(minLimit(first.maxOutputTokens, second.maxOutputTokens) === undefined
      ? {}
      : { maxOutputTokens: minLimit(first.maxOutputTokens, second.maxOutputTokens) as number | false }),
  };
}

function subtractLimit(
  limit: number | false | undefined,
  used: number | undefined,
): number | false | undefined {
  if (limit === undefined || limit === false) return limit;
  return Math.max(0, limit - (used ?? 0));
}

export function remainingWorkflowLimits(
  limits: AgentLimits | undefined,
  budget: WorkflowBudgetUsage | undefined,
): AgentLimits | undefined {
  if (!limits) return undefined;
  return {
    ...(limits.maxSteps === undefined
      ? {}
      : { maxSteps: subtractLimit(limits.maxSteps, budget?.steps) as number }),
    ...(limits.maxToolCalls === undefined
      ? {}
      : { maxToolCalls: subtractLimit(limits.maxToolCalls, budget?.toolCalls) as number }),
    ...(limits.maxInputTokens === undefined
      ? {}
      : {
          maxInputTokens: subtractLimit(
            limits.maxInputTokens,
            budget?.usage?.inputTokens,
          ) as number | false,
        }),
    ...(limits.maxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens: subtractLimit(
            limits.maxOutputTokens,
            budget?.usage?.outputTokens,
          ) as number | false,
        }),
  };
}

export function assertWorkflowBudget(
  workflowName: string,
  limits: AgentLimits | undefined,
  budget: WorkflowBudgetUsage | undefined,
): void {
  if (!limits || !budget) return;
  if (limits.maxSteps !== undefined && budget.steps > limits.maxSteps) {
    throw new Error(`Workflow "${workflowName}" exceeded maxSteps limit of ${limits.maxSteps}`);
  }
  if (limits.maxToolCalls !== undefined && budget.toolCalls > limits.maxToolCalls) {
    throw new Error(
      `Workflow "${workflowName}" exceeded maxToolCalls limit of ${limits.maxToolCalls}`,
    );
  }
  assertTokenBudget(
    `workflow:${workflowName}`,
    'maxInputTokens',
    'inputTokens',
    limits.maxInputTokens,
    budget.usage,
    budget.usage,
  );
  assertTokenBudget(
    `workflow:${workflowName}`,
    'maxOutputTokens',
    'outputTokens',
    limits.maxOutputTokens,
    budget.usage,
    budget.usage,
  );
}

export function addWorkflowBudget(
  first: WorkflowBudgetUsage | undefined,
  second: WorkflowBudgetUsage,
): WorkflowBudgetUsage {
  return {
    usage: addUsage(first?.usage, second.usage),
    steps: (first?.steps ?? 0) + second.steps,
    toolCalls: (first?.toolCalls ?? 0) + second.toolCalls,
  };
}
