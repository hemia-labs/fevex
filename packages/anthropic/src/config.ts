export type AnthropicSchemaPolicy = 'strict' | 'best-effort';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AnthropicConfig {
  apiKey: string;
  baseURL?: string;
  apiVersion?: string;
  schemaPolicy?: AnthropicSchemaPolicy;
  fetch?: FetchLike;
}

export interface ResolvedAnthropicConfig {
  apiKey: string;
  baseURL?: string;
  apiVersion: string;
  schemaPolicy: AnthropicSchemaPolicy;
  fetch: FetchLike;
}

export function resolveAnthropicConfig(config: AnthropicConfig): ResolvedAnthropicConfig {
  if (!isRecord(config)) throw new TypeError('Anthropic config must be an object');
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) {
    throw new TypeError('Anthropic apiKey cannot be empty');
  }
  if (
    config.baseURL !== undefined
    && (typeof config.baseURL !== 'string' || !config.baseURL.trim())
  ) {
    throw new TypeError('Anthropic baseURL must be a non-empty string');
  }
  if (
    config.apiVersion !== undefined
    && (typeof config.apiVersion !== 'string' || !config.apiVersion.trim())
  ) {
    throw new TypeError('Anthropic apiVersion must be a non-empty string');
  }
  if (
    config.schemaPolicy !== undefined
    && config.schemaPolicy !== 'strict'
    && config.schemaPolicy !== 'best-effort'
  ) {
    throw new TypeError('Anthropic schemaPolicy must be "strict" or "best-effort"');
  }

  const requestFetch = config.fetch ?? globalThis.fetch;
  if (typeof requestFetch !== 'function') {
    throw new TypeError('Anthropic adapter requires fetch');
  }

  return {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    apiVersion: config.apiVersion ?? '2026-10-21',
    schemaPolicy: config.schemaPolicy ?? 'strict',
    fetch: requestFetch,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
