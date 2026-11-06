import { describe, expect, test } from 'bun:test';
import { createFevex, defineAgent, defineTool } from './index';
import { fakeModel } from './testing';

describe('tool result limits', () => {
  test('validates configured byte limits', () => {
    const model = fakeModel({ output: 'ok' });
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [
          defineAgent({
            name: 'support',
            instructions: 'Help.',
            limits: { maxToolResultBytes: 0 },
          }),
        ],
      }),
    ).toThrow('maxToolResultBytes');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [defineAgent({ name: 'support', instructions: 'Help.' })],
        tools: [
          defineTool({
            name: 'large',
            maxResultBytes: 0,
            execute() {
              return 'ok';
            },
          }),
        ],
      }),
    ).toThrow('maxResultBytes');
  });

  test('rejects a result above the agent limit', async () => {
    const model = fakeModel(
      { toolCalls: [{ id: 'call-1', name: 'large', input: {} }] },
      { output: 'done' },
    );
    const large = defineTool({
      name: 'large',
      execute() {
        return { data: 'x'.repeat(1_024) };
      },
    });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['large'],
          limits: { maxToolResultBytes: 100 },
        }),
      ],
      tools: [large],
    });

    await expect(app.runAgent('support', { input: 'go' })).rejects.toMatchObject({
      code: 'TOOL_RESULT_TOO_LARGE',
    });
    expect(model.calls).toHaveLength(1);
  });

  test('lets a tool override the agent limit', async () => {
    const model = fakeModel(
      { toolCalls: [{ id: 'call-1', name: 'large', input: {} }] },
      { output: 'done' },
    );
    const large = defineTool({
      name: 'large',
      maxResultBytes: 10_000,
      execute() {
        return { data: 'x'.repeat(1_024) };
      },
    });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['large'],
          limits: { maxToolResultBytes: 100 },
        }),
      ],
      tools: [large],
    });

    await expect(app.runAgent('support', { input: 'go' })).resolves.toMatchObject({
      output: 'done',
    });
  });
});
