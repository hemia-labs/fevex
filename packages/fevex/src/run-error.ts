import type { RunId } from './core';
import type { RunPause } from './runtime';

export type FevexRunErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'WORKFLOW_NOT_FOUND'
  | 'TEAM_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'DURABLE_STORE_REQUIRED'
  | 'RUN_CONFLICT'
  | 'RUN_NOT_RESUMABLE'
  | 'RUN_NOT_RECOVERABLE'
  | 'CHECKPOINT_UNSUPPORTED'
  | 'RUN_DEFINITION_CHANGED'
  | 'POLICY_DENIED'
  | 'CREDENTIAL_NOT_FOUND'
  | 'SANDBOX_REQUIRED'
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
