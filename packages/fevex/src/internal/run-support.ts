import type { JsonObject } from '../core';
import type { ModelUsage } from '../models';
import { toJsonValue } from './json';

export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_MAX_TOOL_CALLS = 16;

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export async function abortable<T>(
  operation: () => T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return await operation();

  const result = await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });

  signal.throwIfAborted();
  return result;
}

export function cancellationReason(signal: AbortSignal): 'aborted' | 'timeout' {
  return signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
    ? 'timeout'
    : 'aborted';
}

export function addUsage(
  first?: ModelUsage,
  second?: ModelUsage,
): ModelUsage | undefined {
  if (!first) return second;
  if (!second) return first;

  const inputTokens = first.inputTokens === undefined && second.inputTokens === undefined
    ? undefined
    : (first.inputTokens ?? 0) + (second.inputTokens ?? 0);
  const outputTokens = first.outputTokens === undefined && second.outputTokens === undefined
    ? undefined
    : (first.outputTokens ?? 0) + (second.outputTokens ?? 0);
  const totalTokens = first.totalTokens === undefined && second.totalTokens === undefined
    ? undefined
    : (first.totalTokens ?? 0) + (second.totalTokens ?? 0);

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function assertTokenBudget(
  agentName: string,
  limitName: 'maxInputTokens' | 'maxOutputTokens',
  usageName: 'inputTokens' | 'outputTokens',
  limit: number | false | undefined,
  stepUsage: ModelUsage | undefined,
  totalUsage: ModelUsage | undefined,
): void {
  if (limit === undefined || limit === false) return;

  const stepTokens = stepUsage?.[usageName];
  if (stepTokens === undefined || !Number.isFinite(stepTokens) || stepTokens < 0) {
    throw new Error(
      `Agent "${agentName}" cannot enforce ${limitName}: model usage.${usageName} is missing or invalid`,
    );
  }

  if ((totalUsage?.[usageName] ?? 0) > limit) {
    throw new Error(`Agent "${agentName}" exceeded ${limitName} limit of ${limit}`);
  }
}

export function assertContinuationBudget(
  agentName: string,
  limitName: 'maxInputTokens' | 'maxOutputTokens',
  usageName: 'inputTokens' | 'outputTokens',
  limit: number | false | undefined,
  totalUsage: ModelUsage | undefined,
): void {
  if (
    limit !== undefined
    && limit !== false
    && (totalUsage?.[usageName] ?? 0) >= limit
  ) {
    throw new Error(
      `Agent "${agentName}" exhausted ${limitName} limit of ${limit} before completing`,
    );
  }
}

export function remainingOutputTokens(
  limit: number | false | undefined,
  usage: ModelUsage | undefined,
): number | undefined {
  if (limit === undefined || limit === false) return undefined;
  return limit - (usage?.outputTokens ?? 0);
}

export function eventUsage(usage: ModelUsage | undefined): JsonObject | undefined {
  if (usage === undefined) return undefined;

  const value = toJsonValue(usage, 'Model usage must be JSON-serializable');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Model usage must be a JSON object');
  }

  return value;
}
