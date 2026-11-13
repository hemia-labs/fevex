import type { RunId } from './core';
import type { RunPause } from './runtime';

export type FevexRunErrorCode =
  | 'INVALID_CURSOR'
  | 'AGENT_NOT_FOUND'
  | 'WORKFLOW_NOT_FOUND'
  | 'TEAM_NOT_FOUND'
  | 'MODEL_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'DURABLE_STORE_REQUIRED'
  | 'RUN_CONFLICT'
  | 'RUN_NOT_RESUMABLE'
  | 'RUN_NOT_RECOVERABLE'
  | 'RUN_WAIT_TIMEOUT'
  | 'CHECKPOINT_UNSUPPORTED'
  | 'RUN_DEFINITION_CHANGED'
  | 'POLICY_DENIED'
  | 'ADMISSION_DENIED'
  | 'RUNTIME_CLOSED'
  | 'RETENTION_UNSUPPORTED'
  | 'RUN_LIST_UNSUPPORTED'
  | 'EVENT_LIMIT_EXCEEDED'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'TOOL_RESULT_TOO_LARGE'
  | 'CREDENTIAL_NOT_FOUND'
  | 'SANDBOX_REQUIRED'
  | 'ELICITATION_INVALID'
  | 'APPROVAL_INVALID'
  | 'RUN_PAUSED'
  | 'TOOL_EXECUTION_UNKNOWN';

export class FevexRunError extends Error {
  readonly name: string = 'FevexRunError';

  constructor(
    readonly code: FevexRunErrorCode,
    message: string,
    readonly runId?: RunId,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class RunPausedError extends FevexRunError {
  override readonly name: string = 'RunPausedError';

  constructor(override readonly runId: RunId, readonly pause: RunPause) {
    super('RUN_PAUSED', `Run "${runId}" is paused`, runId);
  }
}
