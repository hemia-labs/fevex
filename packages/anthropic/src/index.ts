import type { ModelGateway } from '@fevex/core';
import { resolveAnthropicConfig, type AnthropicConfig } from './config';
import { streamAnthropicMessage } from './internal/messages-api';
import {
  restoreAnthropicProviderState,
  serializeAnthropicProviderState,
} from './internal/provider-state';

export { AnthropicError } from './anthropic-error';
export type { AnthropicConfig, AnthropicSchemaPolicy } from './config';

export function createAnthropic(config: AnthropicConfig): (modelId: string) => ModelGateway {
  const resolvedConfig = resolveAnthropicConfig(config);

  return (modelId) => {
    if (typeof modelId !== 'string' || !modelId.trim()) {
      throw new TypeError('Anthropic modelId cannot be empty');
    }

    return {
      metadata: { provider: 'anthropic', model: modelId },
      stateCodec: {
        serialize: (state) => serializeAnthropicProviderState(state, modelId),
        restore: (state) => restoreAnthropicProviderState(state, modelId),
      },
      stream(input) {
        return streamAnthropicMessage(resolvedConfig, modelId, input);
      },
    };
  };
}
