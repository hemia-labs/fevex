import type { ModelGateway } from '@fevex/core';
import { resolveOpenAIConfig, type OpenAIConfig } from './config';
import { streamOpenAIResponse } from './internal/responses-api';
import {
  restoreOpenAIProviderState,
  serializeOpenAIProviderState,
} from './internal/provider-state';

export { OpenAIError } from './openai-error';
export type { OpenAIConfig, OpenAISchemaPolicy } from './config';

export function createOpenAI(config: OpenAIConfig): (modelId: string) => ModelGateway {
  const resolvedConfig = resolveOpenAIConfig(config);

  return (modelId) => {
    if (typeof modelId !== 'string' || !modelId.trim()) {
      throw new TypeError('OpenAI modelId cannot be empty');
    }

    return {
      metadata: { provider: 'openai', model: modelId },
      stateCodec: {
        serialize: (state) => serializeOpenAIProviderState(state, modelId),
        restore: (state) => restoreOpenAIProviderState(state, modelId),
      },
      stream(input) {
        return streamOpenAIResponse(resolvedConfig, modelId, input);
      },
    };
  };
}
