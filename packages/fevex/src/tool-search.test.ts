import { describe, expect, test } from 'bun:test';
import type { ToolSpec } from './core';
import { searchToolSpecs } from './internal/tool-search';
import { createFevex, defineAgent, defineTool, InMemoryRunStore, RunPausedError } from './index';
import { fakeModel } from './testing';

const email = () =>
  defineTool({
    name: 'send_email',
    description: 'Send an email message to a recipient.',
    execute() {
      return 'sent';
    },
  });

const database = () =>
  defineTool({
    name: 'query_database',
    description: 'Run a read-only SQL query against the warehouse.',
    execute() {
      return 'rows';
    },
  });

const searchCall = {
  id: 'search-1',
  name: 'fevex__search_tools',
  input: { query: 'email' },
};

describe('tool search', () => {
  test('searches by name and description', () => {
    const specs: ToolSpec[] = [
      { name: 'send_email', description: 'Send a message.' },
      { name: 'query_database', description: 'Run SQL.' },
      { name: 'create_invoice', description: 'Create a billing invoice.' },
    ];
    expect(searchToolSpecs(specs, 'email', 5).map((tool) => tool.name)).toEqual(['send_email']);
    expect(searchToolSpecs(specs, 'sql warehouse', 5).map((tool) => tool.name)).toEqual([
      'query_database',
    ]);
    expect(searchToolSpecs(specs, 'zzz', 5)).toEqual([]);
    expect(
      searchToolSpecs(
        [{ name: 'lookup', inputSchema: { properties: { email: { type: 'string' } } } }],
        'email',
        5,
      ).map((tool) => tool.name),
    ).toEqual(['lookup']);
  });

  test('exposes only the search tool initially and loads matches on demand', async () => {
    const model = fakeModel(
      { toolCalls: [searchCall] },
      { toolCalls: [{ id: 'call-1', name: 'send_email', input: {} }] },
      { output: 'done' },
    );
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['send_email', 'query_database'],
          toolSearch: { mode: 'on' },
        }),
      ],
      tools: [email(), database()],
    });

    await expect(app.runAgent('support', { input: 'email the customer' })).resolves.toMatchObject({
      output: 'done',
    });

    expect(model.calls[0]!.tools?.map((tool) => tool.name)).toEqual(['fevex__search_tools']);
    const loaded = model.calls[1]!.tools?.map((tool) => tool.name) ?? [];
    expect(loaded).toContain('fevex__search_tools');
    expect(loaded).toContain('send_email');
    expect(loaded).not.toContain('query_database');
    const searchResult = model.calls[1]!.messages.find((message) => message.role === 'tool');
    expect(searchResult?.content).toContain('send_email');
    expect(searchResult?.content).toContain('Send an email');
  });

  test('keeps pinned tools exposed without a search', async () => {
    const model = fakeModel({ output: 'done' });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['send_email', 'query_database'],
          toolSearch: { mode: 'on', pinned: ['send_email'] },
        }),
      ],
      tools: [email(), database()],
    });

    await app.runAgent('support', { input: 'hello' });
    const names = model.calls[0]!.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain('send_email');
    expect(names).toContain('fevex__search_tools');
    expect(names).not.toContain('query_database');
  });

  test('validates tool search configuration', () => {
    const model = fakeModel({ output: 'ok' });
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [
          defineAgent({
            name: 'support',
            instructions: 'Help.',
            toolSearch: { mode: 'sometimes' as never },
          }),
        ],
      }),
    ).toThrow('toolSearch');
    expect(() =>
      createFevex({
        models: { default: model },
        agents: [defineAgent({ name: 'support', instructions: 'Help.' })],
        toolSearch: { limit: 50 },
      }),
    ).toThrow('limit');
  });

  test('auto mode enables search above the tool-count threshold', async () => {
    const model = fakeModel({ output: 'done' });
    const tools = Array.from({ length: 40 }, (_, index) =>
      defineTool({
        name: `tool_${index}`,
        description: `Tool ${index} performs capability ${index}.`,
        execute() {
          return 'ok';
        },
      }),
    );
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: tools.map((tool) => tool.name),
          toolSearch: { mode: 'auto', threshold: 30 },
        }),
      ],
      tools,
    });

    await app.runAgent('support', { input: 'hello' });
    const names = model.calls[0]!.tools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual(['fevex__search_tools']);
    expect(names.length).toBeLessThan(tools.length * 0.5);
  });

  test('auto mode can use the token threshold', async () => {
    const model = fakeModel({ output: 'done' });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['send_email', 'query_database'],
          toolSearch: { mode: 'auto', threshold: 100, tokenThreshold: 1 },
        }),
      ],
      tools: [email(), database()],
    });

    await app.runAgent('support', { input: 'hello' });
    const names = model.calls[0]!.tools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual(['fevex__search_tools']);
  });

  test('auto mode keeps all tools below the threshold', async () => {
    const model = fakeModel({ output: 'done' });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['send_email', 'query_database'],
          toolSearch: { mode: 'auto', threshold: 30 },
        }),
      ],
      tools: [email(), database()],
    });

    await app.runAgent('support', { input: 'hello' });
    const names = model.calls[0]!.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain('send_email');
    expect(names).toContain('query_database');
    expect(names).not.toContain('fevex__search_tools');
  });

  test('does not expose tools outside the agent allowlist', async () => {
    const model = fakeModel(
      { toolCalls: [searchCall] },
      { toolCalls: [{ id: 'call-1', name: 'query_database', input: {} }] },
      { output: 'done' },
    );
    const secret = defineTool({
      name: 'query_database',
      description: 'Run SQL.',
      execute() {
        return 'rows';
      },
    });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['send_email'],
          toolSearch: { mode: 'on' },
        }),
      ],
      tools: [email(), secret],
    });

    await expect(app.runAgent('support', { input: 'email' })).rejects.toThrow(
      'is not available to agent',
    );
    const searchResult = model.calls[1]!.messages.find((message) => message.role === 'tool');
    expect(searchResult?.content).not.toContain('query_database');
  });

  test('keeps approvals on loaded tools', async () => {
    const model = fakeModel(
      { toolCalls: [searchCall] },
      { toolCalls: [{ id: 'call-1', name: 'send_email', input: {} }] },
      { output: 'done' },
    );
    const approvalEmail = defineTool({
      name: 'send_email',
      description: 'Send an email message.',
      approval: 'required',
      execute() {
        return 'sent';
      },
    });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['send_email'],
          toolSearch: { mode: 'on' },
        }),
      ],
      tools: [approvalEmail],
    });

    try {
      await app.runAgent('support', { input: 'email the customer' });
      throw new Error('Expected the run to pause');
    } catch (error) {
      if (!(error instanceof RunPausedError)) throw error;
      expect(error.pause.type).toBe('approval');
      if (error.pause.type === 'approval') {
        expect(error.pause.approval.toolName).toBe('send_email');
      }
    }
  });

  test('restores loaded tools after a pause', async () => {
    const store = new InMemoryRunStore();
    const model = fakeModel(
      { toolCalls: [searchCall] },
      { toolCalls: [{ id: 'call-1', name: 'send_email', input: {} }] },
      { output: 'done' },
    );
    const approvalEmail = defineTool({
      name: 'send_email',
      description: 'Send an email message.',
      approval: 'required',
      execute() {
        return 'sent';
      },
    });
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'support',
          instructions: 'Help.',
          tools: ['send_email'],
          toolSearch: { mode: 'on' },
        }),
      ],
      tools: [approvalEmail],
      runStore: store,
    });

    let paused: RunPausedError | undefined;
    try {
      await app.runAgent('support', { input: 'email the customer' });
    } catch (error) {
      if (!(error instanceof RunPausedError)) throw error;
      paused = error;
    }
    if (!paused) throw new Error('Expected the run to pause');
    expect((await store.getCheckpoint(paused.runId))?.loadedTools).toEqual(['send_email']);

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
    expect(model.calls[2]!.tools?.map((tool) => tool.name)).toContain('send_email');
  });
});
