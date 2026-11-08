import {
  PROVIDER_REASONING_UNSUPPORTED,
  PROVIDER_SCHEMA_UNSUPPORTED,
} from '@fevex/core';

type AnthropicErrorCode =
  | typeof PROVIDER_SCHEMA_UNSUPPORTED
  | typeof PROVIDER_REASONING_UNSUPPORTED;

interface AnthropicErrorOptions {
  status?: number;
  requestId?: string;
  code?: AnthropicErrorCode;
  cause?: unknown;
}

export class AnthropicError extends Error {
  status?: number;
  requestId?: string;
  code?: AnthropicErrorCode;

  constructor(message: string, options: AnthropicErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AnthropicError';
    this.status = options.status;
    this.requestId = options.requestId;
    this.code = options.code;
  }
}
