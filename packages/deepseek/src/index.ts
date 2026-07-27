import type { ModelGateway } from '@fevex/core';
import { resolveDeepSeekConfig, type DeepSeekConfig } from './config';
import { streamChatCompletion } from './internal/chat-completion';
import {
  restoreDeepSeekProviderState,
  serializeDeepSeekProviderState,
} from './internal/provider-state';

export { DeepSeekError } from './deepseek-error';
export type { DeepSeekConfig, DeepSeekSchemaPolicy } from './config';

export function createDeepSeek(config: DeepSeekConfig): (modelId: string) => ModelGateway {
  const resolvedConfig = resolveDeepSeekConfig(config);

  return (modelId) => {
    if (typeof modelId !== 'string' || !modelId.trim()) {
      throw new TypeError('DeepSeek modelId cannot be empty');
    }

    return {
      metadata: { provider: 'deepseek', model: modelId },
      stateCodec: {
        serialize: (state) => serializeDeepSeekProviderState(state, modelId),
        restore: (state) => restoreDeepSeekProviderState(state, modelId),
      },
      stream(input) {
        return streamChatCompletion(resolvedConfig, modelId, input);
      },
    };
  };
}
