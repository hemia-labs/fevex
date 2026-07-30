import type { ModelGateway, ModelInput, ModelResult } from '../models';

export interface FakeModel extends ModelGateway {
  readonly calls: readonly ModelInput[];
}

/** Creates a deterministic model gateway for unit tests. */
export function fakeModel(...responses: ModelResult[]): FakeModel {
  const calls: ModelInput[] = [];

  return {
    calls,
    async *stream(input) {
      input.signal?.throwIfAborted();

      const response = responses[calls.length];
      calls.push(input);

      if (!response) {
        throw new Error(`fakeModel has no response for call ${calls.length}`);
      }

      if (response.output !== undefined) {
        const delta =
          typeof response.output === 'string' ? response.output : JSON.stringify(response.output);
        if (delta) yield { type: 'output.delta' as const, delta };
      }
      yield { type: 'completed' as const, result: response };
    },
  };
}
