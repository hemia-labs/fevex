export type OpenAISchemaPolicy = 'strict' | 'best-effort';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpenAIConfig {
  apiKey: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  schemaName?: string;
  schemaPolicy?: OpenAISchemaPolicy;
  fetch?: FetchLike;
}

export interface ResolvedOpenAIConfig {
  apiKey: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  schemaName?: string;
  schemaPolicy: OpenAISchemaPolicy;
  fetch: FetchLike;
}

export function resolveOpenAIConfig(config: OpenAIConfig): ResolvedOpenAIConfig {
  if (!isRecord(config)) throw new TypeError('OpenAI config must be an object');
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) {
    throw new TypeError('OpenAI apiKey cannot be empty');
  }
  assertOptionalString(config.baseURL, 'baseURL');
  assertOptionalString(config.organization, 'organization');
  assertOptionalString(config.project, 'project');
  if (config.schemaName !== undefined && !isProviderName(config.schemaName)) {
    throw new TypeError(
      'OpenAI schemaName must match [A-Za-z0-9_-]{1,64}',
    );
  }
  if (
    config.schemaPolicy !== undefined
    && config.schemaPolicy !== 'strict'
    && config.schemaPolicy !== 'best-effort'
  ) {
    throw new TypeError('OpenAI schemaPolicy must be "strict" or "best-effort"');
  }

  const requestFetch = config.fetch ?? globalThis.fetch;
  if (typeof requestFetch !== 'function') {
    throw new TypeError('OpenAI adapter requires fetch');
  }

  return {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    organization: config.organization,
    project: config.project,
    schemaName: config.schemaName,
    schemaPolicy: config.schemaPolicy ?? 'strict',
    fetch: requestFetch,
  };
}

function assertOptionalString(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
    throw new TypeError(`OpenAI ${name} must be a non-empty string`);
  }
}

function isProviderName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
