export type DeepSeekSchemaPolicy = 'strict' | 'best-effort';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DeepSeekConfig {
  apiKey: string;
  baseURL?: string;
  schemaPolicy?: DeepSeekSchemaPolicy;
  fetch?: FetchLike;
}

export interface ResolvedDeepSeekConfig {
  apiKey: string;
  baseURL?: string;
  schemaPolicy: DeepSeekSchemaPolicy;
  fetch: FetchLike;
}

export function resolveDeepSeekConfig(config: DeepSeekConfig): ResolvedDeepSeekConfig {
  if (!isRecord(config)) throw new TypeError('DeepSeek config must be an object');
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) {
    throw new TypeError('DeepSeek apiKey cannot be empty');
  }
  if (
    config.baseURL !== undefined
    && (typeof config.baseURL !== 'string' || !config.baseURL.trim())
  ) {
    throw new TypeError('DeepSeek baseURL must be a non-empty string');
  }
  if (
    config.schemaPolicy !== undefined
    && config.schemaPolicy !== 'strict'
    && config.schemaPolicy !== 'best-effort'
  ) {
    throw new TypeError('DeepSeek schemaPolicy must be "strict" or "best-effort"');
  }

  const requestFetch = config.fetch ?? globalThis.fetch;
  if (typeof requestFetch !== 'function') {
    throw new TypeError('DeepSeek adapter requires fetch');
  }

  return {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    schemaPolicy: config.schemaPolicy ?? 'strict',
    fetch: requestFetch,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
