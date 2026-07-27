import {
  PROVIDER_REASONING_UNSUPPORTED,
  PROVIDER_SCHEMA_UNSUPPORTED,
} from '@fevex/core';

type DeepSeekErrorCode =
  | typeof PROVIDER_SCHEMA_UNSUPPORTED
  | typeof PROVIDER_REASONING_UNSUPPORTED;

interface DeepSeekErrorOptions {
  status?: number;
  requestId?: string;
  code?: DeepSeekErrorCode;
  cause?: unknown;
}

export class DeepSeekError extends Error {
  status?: number;
  requestId?: string;
  code?: DeepSeekErrorCode;

  constructor(message: string, options: DeepSeekErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'DeepSeekError';
    this.status = options.status;
    this.requestId = options.requestId;
    this.code = options.code;
  }
}
