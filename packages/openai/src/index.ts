import type {
  AgentMessage,
  JsonObject,
  JsonValue,
  ModelGateway,
  ModelGenerateInput,
  ModelGenerateResult,
  ModelUsage,
  ToolCall,
  ToolSpec,
} from 'fevex';

export interface OpenAIConfig {
  apiKey: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  schemaName?: string;
  fetch?: FetchLike;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class OpenAIError extends Error {
  status?: number;
  requestId?: string;

  constructor(message: string, options: { status?: number; requestId?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'OpenAIError';
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

type ResponseInputItem =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

type OpenAIResponse = {
  output?: unknown[];
  output_text?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
  };
};

const defaultBaseURL = 'https://api.openai.com/v1';

export function createOpenAI(config: OpenAIConfig): (modelId: string) => ModelGateway {
  if (!config.apiKey.trim()) throw new TypeError('OpenAI apiKey cannot be empty');

  const requestFetch: FetchLike = config.fetch ?? globalThis.fetch;
  if (typeof requestFetch !== 'function') {
    throw new TypeError('OpenAI adapter requires fetch');
  }

  return (modelId) => {
    if (!modelId.trim()) throw new TypeError('OpenAI modelId cannot be empty');

    return {
      async generate(input) {
        const response = await sendResponse(config, requestFetch, modelId, input);
        return parseResponse(response);
      },
    };
  };
}

async function sendResponse(
  config: OpenAIConfig,
  requestFetch: FetchLike,
  modelId: string,
  input: ModelGenerateInput,
): Promise<OpenAIResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
  };
  if (config.organization) headers['openai-organization'] = config.organization;
  if (config.project) headers['openai-project'] = config.project;

  const body = {
    ...input.modelOptions,
    model: modelId,
    input: toOpenAIInput(input.messages),
    ...(input.tools?.length ? { tools: input.tools.map(toOpenAITool), parallel_tool_calls: false } : {}),
    ...(input.outputSchema ? {
      text: {
        format: {
          type: 'json_schema',
          name: config.schemaName ?? 'fevex_output',
          strict: true,
          schema: input.outputSchema,
        },
      },
    } : {}),
    ...(input.reasoning && input.reasoning !== 'provider-default' ? { reasoning: { effort: input.reasoning } } : {}),
  };

  let response: Response;

  try {
    response = await requestFetch(`${(config.baseURL ?? defaultBaseURL).replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (error) {
    throw new OpenAIError('OpenAI request failed', { cause: error });
  }

  const requestId = response.headers.get('x-request-id') ?? undefined;
  const data = await readJson(response);

  if (!response.ok) {
    throw new OpenAIError(toOpenAIErrorMessage(data, response.status), {
      status: response.status,
      requestId,
      cause: data,
    });
  }

  return data as OpenAIResponse;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OpenAIError('OpenAI response was not valid JSON', {
      status: response.status,
      requestId: response.headers.get('x-request-id') ?? undefined,
      cause: error,
    });
  }
}

function toOpenAIInput(messages: AgentMessage[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: message.content,
      });
      continue;
    }

    input.push({
      role: message.role,
      content: message.content,
    });

    for (const toolCall of message.toolCalls ?? []) {
      input.push({
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.input),
      });
    }
  }

  return input;
}

function toOpenAITool(tool: ToolSpec): JsonObject {
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    strict: true,
  };
}

function parseResponse(response: OpenAIResponse): ModelGenerateResult {
  const toolCalls = parseToolCalls(response.output);
  const output = parseOutput(response);
  const usage = parseUsage(response.usage);

  if (output === undefined && !toolCalls?.length) {
    throw new OpenAIError('OpenAI response returned no output');
  }

  return {
    ...(output === undefined ? {} : { output }),
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
  };
}

function parseToolCalls(output: unknown): ToolCall[] | undefined {
  if (!Array.isArray(output)) return undefined;

  const calls: ToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'function_call') continue;

    const id = typeof item.call_id === 'string' ? item.call_id : String(item.id ?? '');
    const name = typeof item.name === 'string' ? item.name : '';
    const rawArguments = typeof item.arguments === 'string' ? item.arguments : '{}';

    let parsedArguments: JsonValue;
    try {
      parsedArguments = JSON.parse(rawArguments) as JsonValue;
    } catch (error) {
      throw new OpenAIError(`OpenAI tool call "${name}" returned invalid JSON arguments`, { cause: error });
    }

    calls.push({ id, name, input: parsedArguments });
  }

  return calls.length ? calls : undefined;
}

function parseOutput(response: OpenAIResponse): JsonValue | undefined {
  if (typeof response.output_text === 'string') return parseMaybeJson(response.output_text);
  if (!Array.isArray(response.output)) return undefined;

  const texts: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item)) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (isRecord(content) && typeof content.text === 'string') texts.push(content.text);
      }
    }
  }

  if (!texts.length) return undefined;
  return parseMaybeJson(texts.join(''));
}

function parseMaybeJson(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function parseUsage(usage: OpenAIResponse['usage']): ModelUsage | undefined {
  if (!usage) return undefined;

  return {
    ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
  };
}

function toOpenAIErrorMessage(data: unknown, status: number): string {
  if (isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string') {
    return data.error.message;
  }

  return `OpenAI request failed with status ${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
