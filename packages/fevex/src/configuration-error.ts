/**
 * Composition error codes.
 *
 * `INVALID_CONFIG` is reserved for the shape of the root config object. Every
 * registered entity has its own `INVALID_*` code, plus `DUPLICATE_*` when it is
 * registered by name and `MISSING_*` when an agent references something that
 * was never registered.
 */
export type FevexConfigurationErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_MODEL'
  | 'INVALID_AGENT'
  | 'INVALID_TOOL'
  | 'INVALID_WORKFLOW'
  | 'INVALID_CONNECTION'
  | 'INVALID_CONTEXT_PROVIDER'
  | 'INVALID_POLICY'
  | 'DUPLICATE_AGENT'
  | 'DUPLICATE_TOOL'
  | 'DUPLICATE_WORKFLOW'
  | 'DUPLICATE_CONTEXT_PROVIDER'
  | 'MISSING_MODEL'
  | 'MISSING_TOOL';

export class FevexConfigurationError extends Error {
  constructor(
    readonly code: FevexConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FevexConfigurationError';
  }
}
