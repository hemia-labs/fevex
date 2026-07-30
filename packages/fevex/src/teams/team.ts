import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AgentLimits } from '../agents';
import type { ExecutionContext, JsonObject } from '../core';
import type { ExactDefinition } from '../internal/exact-definition';
import type { RunRequest } from '../runtime';
import type {
  WorkflowAgentResult,
  WorkflowDefinition,
  WorkflowStep,
} from '../workflows';

export interface TeamMember {
  agent: string;
  role: string;
  description?: string;
}

export interface TeamLimits extends AgentLimits {
  maxDelegations?: number;
  maxParallel?: number;
}

export interface TeamDelegation<TInput = unknown> {
  agent: string;
  task: TInput;
  context?: ExecutionContext;
  limits?: AgentLimits;
  expectedOutput?: string;
  constraints?: string[];
}

export interface TeamHandoff<TInput = unknown>
  extends Omit<TeamDelegation<TInput>, 'agent'> {
  from: string;
  to: string;
  reason: string;
}

export type TeamTaskResult<TOutput = unknown> = WorkflowAgentResult<TOutput> & {
  delegationId: string;
  agentName: string;
};

export interface TeamStep {
  delegate<TInput = unknown, TOutput = unknown>(
    delegationId: string,
    delegation: TeamDelegation<TInput>,
  ): Promise<TeamTaskResult<TOutput>>;
  handoff<TInput = unknown, TOutput = unknown>(
    delegationId: string,
    handoff: TeamHandoff<TInput>,
  ): Promise<TeamTaskResult<TOutput>>;
  parallel<TTasks extends Record<string, () => Promise<unknown>>>(
    stepId: string,
    tasks: TTasks,
  ): Promise<{ [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>> }>;
}

export interface TeamDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  version?: string;
  supervisor: string;
  members: TeamMember[];
  limits?: TeamLimits;
  inputSchema?: StandardSchemaV1<unknown, TInput>;
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  run(team: TeamStep, input: TInput): TOutput | Promise<TOutput>;
}

export function defineTeam<T extends TeamDefinition>(
  team: ExactDefinition<T, TeamDefinition>,
): T {
  return team;
}

/** @internal Compiles teams onto the existing durable workflow engine. */
export function teamAsWorkflow(team: TeamDefinition): WorkflowDefinition {
  const allowed = new Set([team.supervisor, ...team.members.map(({ agent }) => agent)]);
  const limits: AgentLimits | undefined = team.limits && {
    ...(team.limits.maxSteps === undefined ? {} : { maxSteps: team.limits.maxSteps }),
    ...(team.limits.maxToolCalls === undefined
      ? {}
      : { maxToolCalls: team.limits.maxToolCalls }),
    ...(team.limits.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: team.limits.maxInputTokens }),
    ...(team.limits.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: team.limits.maxOutputTokens }),
  };

  return {
    name: team.name,
    version: team.version ?? '1',
    inputSchema: team.inputSchema,
    outputSchema: team.outputSchema,
    limits,
    async run(step, input) {
      let delegations = 0;
      const countDelegation = () => {
        delegations += 1;
        if (
          team.limits?.maxDelegations !== undefined
          && delegations > team.limits.maxDelegations
        ) {
          throw new Error(
            `Team "${team.name}" exceeded maxDelegations limit of ${team.limits.maxDelegations}`,
          );
        }
      };
      const runAgent = async <TInput, TOutput>(
        delegationId: string,
        delegation: TeamDelegation<TInput>,
        metadata: JsonObject,
      ): Promise<TeamTaskResult<TOutput>> => {
        if (!delegationId.trim()) throw new Error('Team delegation id cannot be empty');
        if (!allowed.has(delegation.agent)) {
          throw new Error(
            `Agent "${delegation.agent}" is not a member of team "${team.name}"`,
          );
        }
        if (
          delegation.expectedOutput !== undefined
          && !delegation.expectedOutput.trim()
        ) {
          throw new Error('Team delegation expectedOutput cannot be empty');
        }
        if (
          delegation.constraints !== undefined
          && (
            !Array.isArray(delegation.constraints)
            || delegation.constraints.some(
              (constraint) => typeof constraint !== 'string' || !constraint.trim(),
            )
          )
        ) {
          throw new Error('Team delegation constraints must be non-empty strings');
        }
        countDelegation();
        const request: RunRequest<TInput, TOutput> = {
          input: delegation.task,
          ...(delegation.context === undefined ? {} : { context: delegation.context }),
          ...(delegation.limits === undefined ? {} : { limits: delegation.limits }),
        };
        const result = await step.agent<TInput, TOutput>(
          delegationId,
          delegation.agent,
          request,
          { metadata },
        );
        return {
          ...result,
          delegationId,
          agentName: delegation.agent,
        };
      };
      const teamStep: TeamStep = {
        delegate(delegationId, delegation) {
          return runAgent(delegationId, delegation, {
            teamAction: 'delegate',
            ...(delegation.expectedOutput === undefined
              ? {}
              : { expectedOutput: delegation.expectedOutput }),
            ...(delegation.constraints === undefined
              ? {}
              : { constraints: delegation.constraints }),
          });
        },
        handoff(delegationId, handoff) {
          if (!allowed.has(handoff.from)) {
            throw new Error(
              `Agent "${handoff.from}" is not a member of team "${team.name}"`,
            );
          }
          if (!handoff.reason.trim()) throw new Error('Team handoff reason cannot be empty');
          return runAgent(
            delegationId,
            {
              agent: handoff.to,
              task: handoff.task,
              context: handoff.context,
              limits: handoff.limits,
              expectedOutput: handoff.expectedOutput,
              constraints: handoff.constraints,
            },
            {
              teamAction: 'handoff',
              from: handoff.from,
              reason: handoff.reason,
              ...(handoff.expectedOutput === undefined
                ? {}
                : { expectedOutput: handoff.expectedOutput }),
              ...(handoff.constraints === undefined
                ? {}
                : { constraints: handoff.constraints }),
            },
          );
        },
        parallel(stepId, tasks) {
          const width = Object.keys(tasks).length;
          if (
            team.limits?.maxParallel !== undefined
            && width > team.limits.maxParallel
          ) {
            throw new Error(
              `Team "${team.name}" exceeded maxParallel limit of ${team.limits.maxParallel}`,
            );
          }
          return step.parallel(stepId, tasks, {
            metadata: { teamAction: 'merge', width },
          });
        },
      };
      return team.run(teamStep, input);
    },
  };
}
