import type {
  ModelGateway,
  ModelGenerateInput,
  ModelGenerateResult,
} from '../models';
import type { JsonObject, ToolCall } from '../core';

export interface FakeModel extends ModelGateway {
  readonly calls: readonly ModelGenerateInput[];
}

export function fakeModel(...responses: ModelGenerateResult[]): FakeModel {
  const calls: ModelGenerateInput[] = [];

  return {
    calls,
    async generate(input) {
      input.signal?.throwIfAborted();

      const response = responses[calls.length];
      calls.push(input);

      if (!response) {
        throw new Error(`fakeModel has no response for call ${calls.length}`);
      }

      return response;
    },
  };
}

export interface ModelGatewayContract {
  output?: unknown;
  toolCall?: ToolCall;
  usage?: boolean;
  error?: Error;
}

const contractOutputSchema: JsonObject = { type: 'string' };
const contractToolInputSchema: JsonObject = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

export async function testModelGateway(model: ModelGateway, contract: ModelGatewayContract = {}): Promise<void> {
  const output = contract.output ?? 'ok';
  const toolCall = contract.toolCall ?? { id: 'call-1', name: 'lookup', input: { query: 'value' } };
  const outputResult = await model.generate({
    messages: [{ role: 'user', content: 'Return a final answer.' }],
    outputSchema: contractOutputSchema,
  });

  assert(outputResult.output !== undefined, 'ModelGateway must return output for a final answer');
  assert(outputResult.output === output, 'ModelGateway returned an unexpected output');

  if (contract.usage) {
    assert(outputResult.usage !== undefined, 'ModelGateway must return usage when the contract requires it');
  }

  const toolResult = await model.generate({
    messages: [{ role: 'user', content: 'Call lookup.' }],
    tools: [{ name: 'lookup', description: 'Look up a value.', inputSchema: contractToolInputSchema }],
  });

  assert(toolResult.toolCalls?.length === 1, 'ModelGateway must return one tool call');
  assert(toolResult.toolCalls[0]?.id === toolCall.id, 'ModelGateway returned an unexpected tool call id');
  assert(toolResult.toolCalls[0]?.name === toolCall.name, 'ModelGateway returned an unexpected tool name');

  const controller = new AbortController();
  controller.abort();
  await model.generate({
    messages: [{ role: 'user', content: 'This call is aborted.' }],
    signal: controller.signal,
  }).then(
    () => {
      throw new TypeError('ModelGateway must reject aborted calls');
    },
    () => {},
  );

  if (contract.error) {
    await model.generate({
      messages: [{ role: 'user', content: 'Propagate an error.' }],
    }).then(
      () => {
        throw new TypeError('ModelGateway must propagate provider errors');
      },
      (error) => {
        assert(error === contract.error, 'ModelGateway must preserve provider error identity');
      },
    );
  }
}
