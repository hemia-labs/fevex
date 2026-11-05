import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../core';
import { createFevex, defineAgent } from '../index';
import { fakeModel } from '../testing';
import { createAgentsMdContextProvider } from './agents-md';
import type { KnowledgeContext } from './knowledge';
import { loadSkillFile } from './skill-file';

const context = (input = 'hello'): KnowledgeContext => ({
  agentName: 'support',
  input,
  sessionId: 'session-1',
});

async function withTemporaryDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'fevex-skill-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('SKILL.md progressive disclosure', () => {
  test('parses metadata, instructions and resources', async () => {
    await withTemporaryDirectory(async (root) => {
      await mkdir(join(root, 'references'));
      await writeFile(
        join(root, 'SKILL.md'),
        [
          '---',
          'name: refunds',
          'description: >',
          '  Handle refund requests',
          '  and policy exceptions.',
          '---',
          '',
          'Refunds are allowed for 30 days.',
        ].join('\n'),
      );
      await writeFile(join(root, 'references', 'policy.md'), 'Policy details.');

      const skill = await loadSkillFile(join(root, 'SKILL.md'));
      expect(skill.name).toBe('refunds');
      expect(skill.description).toBe('Handle refund requests and policy exceptions.');
      expect(await skill.read(context())).toEqual([
        {
          id: 'refunds:metadata',
          content: 'Handle refund requests and policy exceptions.',
        },
      ]);

      const loaded = await skill.load(context());
      expect(loaded[0]).toEqual({
        id: 'refunds:instructions',
        content: 'Refunds are allowed for 30 days.',
      });
      expect(loaded[1]?.content).toContain('references/policy.md');
      expect((await skill.load(context(), 'references/policy.md'))[0]?.content).toBe(
        'Policy details.',
      );
      await expect(skill.load(context(), '../outside.md')).rejects.toThrow(
        'outside the skill directory',
      );
    });
  });

  test('advertises only metadata until the model loads the skill', async () => {
    await withTemporaryDirectory(async (root) => {
      await writeFile(
        join(root, 'SKILL.md'),
        '---\nname: refunds\ndescription: Handle refunds.\n---\n\nUNIQUE_SKILL_BODY refunds are allowed for 30 days.',
      );
      const skill = await loadSkillFile(join(root, 'SKILL.md'));
      const model = fakeModel(
        {
          toolCalls: [{ id: 'load-1', name: 'fevex__load_skill', input: { name: 'refunds' } }],
        },
        { output: 'done' },
      );
      const events: AgentEvent[] = [];
      const app = createFevex({
        models: { test: model },
        contextProviders: [skill],
        agents: [
          defineAgent({
            name: 'support',
            instructions: 'Help.',
            model: 'test',
            skills: ['refunds'],
          }),
        ],
        onEvent: (event) => events.push(event),
      });

      await expect(app.runAgent('support', { input: 'refund please' })).resolves.toMatchObject({
        output: 'done',
      });

      const first = model.calls[0]!;
      const initial = first.messages.map((message) => message.content).join('\n');
      expect(initial).toContain('Handle refunds.');
      expect(initial).not.toContain('UNIQUE_SKILL_BODY');
      expect(first.tools?.map((tool) => tool.name)).toContain('fevex__load_skill');

      const second = model.calls[1]!;
      const toolResult = second.messages.find((message) => message.role === 'tool');
      expect(toolResult?.content).toContain('UNIQUE_SKILL_BODY');
      expect(
        second.messages.some(
          (message) =>
            message.role === 'assistant'
            && message.toolCalls?.[0]?.name === 'fevex__load_skill',
        ),
      ).toBe(true);
      expect(events.map((event) => event.type)).toContain('tool.started');
      expect(events.map((event) => event.type)).toContain('tool.completed');
    });
  });

  test('rejects resources that escape through symlinks', async () => {
    await withTemporaryDirectory(async (root) => {
      await mkdir(join(root, 'skill', 'references'), { recursive: true });
      await writeFile(join(root, 'secret.md'), 'outside the skill directory');
      await writeFile(
        join(root, 'skill', 'SKILL.md'),
        '---\nname: refunds\ndescription: Handle refunds.\n---\nBody.',
      );
      await symlink(join(root, 'secret.md'), join(root, 'skill', 'references', 'link.md'));

      const skill = await loadSkillFile(join(root, 'skill', 'SKILL.md'));
      await expect(skill.load(context(), 'references/link.md')).rejects.toThrow(
        'outside the skill directory',
      );
    });
  });

  test('rejects invalid frontmatter and names', async () => {
    await withTemporaryDirectory(async (root) => {
      await writeFile(join(root, 'missing.md'), 'No frontmatter.');
      await expect(loadSkillFile(join(root, 'missing.md'))).rejects.toThrow('frontmatter');

      await writeFile(
        join(root, 'invalid-name.md'),
        '---\nname: Bad Name\ndescription: Invalid.\n---\nBody.',
      );
      await expect(loadSkillFile(join(root, 'invalid-name.md'))).rejects.toThrow('invalid name');
    });
  });
});

describe('AGENTS.md context', () => {
  test('reads one explicit file into the run context', async () => {
    await withTemporaryDirectory(async (root) => {
      await writeFile(join(root, 'AGENTS.md'), 'Use Bun.\nRun tests with bun test.');
      const provider = createAgentsMdContextProvider(join(root, 'AGENTS.md'));
      const model = fakeModel({ output: 'ok' });
      const app = createFevex({
        models: { test: model },
        contextProviders: [provider],
        agents: [
          defineAgent({
            name: 'support',
            instructions: 'Help.',
            model: 'test',
            context: ['agents-md'],
          }),
        ],
      });

      await expect(app.runAgent('support', { input: 'hello' })).resolves.toMatchObject({
        output: 'ok',
      });
      expect(
        model.calls[0]!.messages.map((message) => message.content).join('\n'),
      ).toContain('Use Bun.');
    });
  });
});
