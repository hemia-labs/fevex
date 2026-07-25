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

export interface DeepSeekConfig {
  apiKey: string;
  baseURL?: string;
  fetch?: FetchLike;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class DeepSeekError extends Error {
  status?: number;
  requestId?: string;

  constructor(message: string, options: { status?: number; requestId?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'DeepSeekError';
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type ChatToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
};

const defaultBaseURL = 'https://api.deepseek.com';

export function createDeepSeek(config: DeepSeekConfig): (modelId: string) => ModelGateway {
  if (!config.apiKey.trim()) throw new TypeError('DeepSeek apiKey cannot be empty');

  const requestFetch: FetchLike = config.fetch ?? globalThis.fetch;
  if (typeof requestFetch !== 'function') {
    throw new TypeError('DeepSeek adapter requires fetch');
  }

  return (modelId) => {
    if (!modelId.trim()) throw new TypeError('DeepSeek modelId cannot be empty');

    return {
      async generate(input) {
        const response = await sendChatCompletion(config, requestFetch, modelId, input);
        return parseResponse(response);
      },
    };
  };
}

async function sendChatCompletion(
  config: DeepSeekConfig,
  requestFetch: FetchLike,
  modelId: string,
  input: ModelGenerateInput,
): Promise<DeepSeekResponse> {
  const body = {
    ...input.modelOptions,
    model: modelId,
    messages: toDeepSeekMessages(input.messages),
    ...(input.tools?.length ? { tools: input.tools.map(toDeepSeekTool), parallel_tool_calls: false } : {}),
    ...(input.outputSchema ? { response_format: { type: 'json_object' } } : {}),
  };

  let response: Response;

  try {
    response = await requestFetch(`${(config.baseURL ?? defaultBaseURL).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (error) {
    throw new DeepSeekError('DeepSeek request failed', { cause: error });
  }

  const requestId = response.headers.get('x-ds-request-id') ?? response.headers.get('x-request-id') ?? undefined;
  const data = await readJson(response);

  if (!response.ok) {
    throw new DeepSeekError(toDeepSeekErrorMessage(data, response.status), {
      status: response.status,
      requestId,
      cause: data,
    });
  }

  return data as DeepSeekResponse;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DeepSeekError('DeepSeek response was not valid JSON', {
      status: response.status,
      requestId: response.headers.get('x-ds-request-id') ?? response.headers.get('x-request-id') ?? undefined,
      cause: error,
    });
  }
}

function toDeepSeekMessages(messages: AgentMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      };
    }

    return {
      role: message.role,
      content: message.content,
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(toDeepSeekToolCall) } : {}),
    };
  });
}

function toDeepSeekToolCall(toolCall: ToolCall): ChatToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input),
    },
  };
}

function toDeepSeekTool(tool: ToolSpec): JsonObject {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  };
}

function parseResponse(response: DeepSeekResponse): ModelGenerateResult {
  const message = response.choices?.[0]?.message;
  const toolCalls = parseToolCalls(message?.tool_calls);
  const output = typeof message?.content === 'string' ? parseMaybeJson(message.content) : undefined;
  const usage = parseUsage(response.usage);

  if (output === undefined && !toolCalls?.length) {
    throw new DeepSeekError('DeepSeek response returned no output');
  }

  return {
    ...(output === undefined ? {} : { output }),
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
  };
}

function parseToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const calls: ToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.function)) continue;

    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.function.name === 'string' ? item.function.name : '';
    const rawArguments = typeof item.function.arguments === 'string' ? item.function.arguments : '{}';

    let parsedArguments: JsonValue;
    try {
      parsedArguments = JSON.parse(rawArguments) as JsonValue;
    } catch (error) {
      throw new DeepSeekError(`DeepSeek tool call "${name}" returned invalid JSON arguments`, { cause: error });
    }

    calls.push({ id, name, input: parsedArguments });
  }

  return calls.length ? calls : undefined;
}

function parseMaybeJson(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function parseUsage(usage: DeepSeekResponse['usage']): ModelUsage | undefined {
  if (!usage) return undefined;

  return {
    ...(typeof usage.prompt_tokens === 'number' ? { inputTokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === 'number' ? { outputTokens: usage.completion_tokens } : {}),
    ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
  };
}

function toDeepSeekErrorMessage(data: unknown, status: number): string {
  if (isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string') {
    return data.error.message;
  }

  return `DeepSeek request failed with status ${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
