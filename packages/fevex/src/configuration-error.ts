export type FevexConfigurationErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_MODEL'
  | 'INVALID_AGENT'
  | 'INVALID_TOOL'
  | 'DUPLICATE_AGENT'
  | 'DUPLICATE_TOOL'
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
