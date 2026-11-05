import { describe, expect, test } from 'bun:test';
import type { AgentEvent, AgentMessage, ContextBudget } from './index';
import type { ContextCompactionInput } from './runtime';
import {
  createFevex,
  defineAgent,
  defineTool,
  InMemoryRunStore,
  RunPausedError,
} from './index';
import { fakeModel } from './testing';

const budget = (overrides: Partial<ContextBudget> = {}): ContextBudget => ({
  maxInputTokens: 400,
  reserveOutputTokens: 0,
  compactAt: 0.8,
  targetTokens: 100,
  ...overrides,
});

async function seedSession(
  store: InMemoryRunStore,
  sessionId: string,
  history: AgentMessage[],
): Promise<void> {
  const now = new Date().toISOString();
  await store.saveSession({ id: sessionId, history, createdAt: now, updatedAt: now });
}

function history(count: number, marker = 'OLD'): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${marker}_${index} ${'context '.repeat(20)}`,
  }));
}

describe('automatic context compaction', () => {
  test('compacts older session history and keeps the original log', async () => {
    const store = new InMemoryRunStore();
    const sessionId = 'session-1';
    const original = history(20);
    await seedSession(store, sessionId, original);
    const model = fakeModel({ output: 'done' });
    const events: AgentEvent[] = [];
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          contextBudget: budget(),
        }),
      ],
      runStore: store,
      onEvent: (event) => events.push(event),
    });

    await expect(
      app.runAgent('support', { input: 'latest question', sessionId }),
    ).resolves.toMatchObject({ output: 'done' });

    const prompt = model.calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('[Compacted conversation');
    expect(prompt).not.toContain('OLD_0 ');
    expect(prompt).toContain('latest question');

    const compacted = events.find((event) => event.type === 'context.compacted');
    if (compacted?.type !== 'context.compacted') throw new Error('Expected a compaction event');
    expect(compacted.payload.removedMessages).toBe(original.length);
    expect(compacted.payload.summary).toContain('Compacted conversation');

    const stored = await store.getSession(sessionId);
    expect(stored?.history).toHaveLength(original.length + 2);
    expect(stored?.history[0]?.content).toContain('OLD_0');
  });

  test('preserves the current turn and its tool results', async () => {
    const store = new InMemoryRunStore();
    const sessionId = 'session-2';
    await seedSession(store, sessionId, history(20));
    const model = fakeModel(
      { toolCalls: [{ id: 'call-1', name: 'lookup', input: { query: 'x' } }] },
      { output: 'done' },
    );
    const lookup = defineTool({
      name: 'lookup',
      execute() {
        return 'TOOL_RESULT_UNIQUE';
      },
    });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['lookup'],
          contextBudget: budget(),
        }),
      ],
      tools: [lookup],
      runStore: store,
    });

    await expect(
      app.runAgent('support', { input: 'latest question', sessionId }),
    ).resolves.toMatchObject({ output: 'done' });

    const second = model.calls[1]!.messages;
    expect(second.some((message) => message.content.includes('TOOL_RESULT_UNIQUE'))).toBe(true);
    expect(
      second.some(
        (message) => message.role === 'assistant' && message.toolCalls?.[0]?.id === 'call-1',
      ),
    ).toBe(true);
    expect(second.map((message) => message.content).join('\n')).toContain('latest question');
  });

  test('uses an injected compactor for older messages only', async () => {
    const store = new InMemoryRunStore();
    const sessionId = 'session-3';
    await seedSession(store, sessionId, history(20));
    let received: ContextCompactionInput | undefined;
    const model = fakeModel({ output: 'done' });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          contextBudget: budget(),
        }),
      ],
      compaction: {
        compactor: {
          compact(input) {
            received = input;
            return [{ role: 'system', content: 'CUSTOM SUMMARY' }];
          },
        },
      },
      runStore: store,
    });

    await expect(
      app.runAgent('support', { input: 'latest question', sessionId }),
    ).resolves.toMatchObject({ output: 'done' });

    expect(received?.agentName).toBe('support');
    expect(
      received?.messages.every((message) => !message.content.includes('latest question')),
    ).toBe(true);
    expect(
      model.calls[0]!.messages.some((message) => message.content === 'CUSTOM SUMMARY'),
    ).toBe(true);
  });

  test('applies a runtime-wide context budget', async () => {
    const store = new InMemoryRunStore();
    const sessionId = 'session-5';
    await seedSession(store, sessionId, history(20));
    const model = fakeModel({ output: 'done' });
    const events: AgentEvent[] = [];
    const app = createFevex({
      models: { default: model },
      agents: [defineAgent({ name: 'support', instructions: 'Help.' })],
      contextBudget: budget(),
      runStore: store,
      onEvent: (event) => events.push(event),
    });

    await expect(
      app.runAgent('support', { input: 'latest question', sessionId }),
    ).resolves.toMatchObject({ output: 'done' });
    expect(events.some((event) => event.type === 'context.compacted')).toBe(true);
  });

  test('validates context budgets and compactors at configuration time', () => {
    const model = fakeModel({ output: 'ok' });
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [
          defineAgent({
            name: 'support',
            instructions: 'Help.',
            contextBudget: { maxInputTokens: 0 },
          }),
        ],
      }),
    ).toThrow('contextBudget');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [defineAgent({ name: 'support', instructions: 'Help.' })],
        compaction: { compactor: {} as never },
      }),
    ).toThrow('compactor');
  });

  test('fails before the model when the current turn cannot fit', async () => {
    const model = fakeModel({ output: 'unused' });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          contextBudget: budget({ maxInputTokens: 100, targetTokens: 40 }),
        }),
      ],
    });

    await expect(
      app.runAgent('support', { input: 'x'.repeat(1_000) }),
    ).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
    expect(model.calls).toHaveLength(0);
  });

  test('persists the summary in the checkpoint and resumes', async () => {
    const store = new InMemoryRunStore();
    const sessionId = 'session-4';
    await seedSession(store, sessionId, history(20));
    const model = fakeModel(
      { toolCalls: [{ id: 'call-1', name: 'lookup', input: {} }] },
      { output: 'approved' },
    );
    const lookup = defineTool({
      name: 'lookup',
      approval: 'required',
      execute() {
        return 'found';
      },
    });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['lookup'],
          contextBudget: budget(),
        }),
      ],
      tools: [lookup],
      runStore: store,
    });

    let paused: RunPausedError | undefined;
    try {
      await app.runAgent('support', { input: 'latest question', sessionId });
    } catch (error) {
      if (!(error instanceof RunPausedError)) throw error;
      paused = error;
    }
    if (!paused) throw new Error('Expected the run to pause');

    const checkpoint = await store.getCheckpoint(paused.runId);
    expect(checkpoint?.contextBudget).toMatchObject({ maxInputTokens: 400 });
    expect(
      checkpoint?.messages.some((message) =>
        message.content.includes('[Compacted conversation'),
      ),
    ).toBe(true);

    await app.resumeRun(paused.runId, {
      type: 'approval',
      approvalId: paused.pause.type === 'approval' ? paused.pause.approval.id : '',
      decision: 'approve',
      actor: { id: 'reviewer' },
    });
    let resumed = await app.getRun(paused.runId);
    for (let attempt = 0; attempt < 50 && resumed?.status === 'running'; attempt += 1) {
      await Bun.sleep(10);
      resumed = await app.getRun(paused.runId);
    }
    expect(resumed?.status).toBe('completed');
    expect(resumed?.output).toBe('approved');
  });
});
