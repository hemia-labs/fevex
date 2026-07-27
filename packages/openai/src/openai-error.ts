import {
  PROVIDER_REASONING_UNSUPPORTED,
  PROVIDER_SCHEMA_UNSUPPORTED,
} from '@fevex/core';

type OpenAIErrorCode =
  | typeof PROVIDER_SCHEMA_UNSUPPORTED
  | typeof PROVIDER_REASONING_UNSUPPORTED;

interface OpenAIErrorOptions {
  status?: number;
  requestId?: string;
  code?: OpenAIErrorCode;
  cause?: unknown;
}

export class OpenAIError extends Error {
  status?: number;
  requestId?: string;
  code?: OpenAIErrorCode;

  constructor(message: string, options: OpenAIErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'OpenAIError';
    this.status = options.status;
    this.requestId = options.requestId;
    this.code = options.code;
  }
}
