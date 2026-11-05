import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  defineContextProvider,
  type ContextBlock,
  type KnowledgeContext,
  type ProgressiveSkillProvider,
} from './knowledge';

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_RESOURCE_BYTES = 256 * 1024;
const MAX_RESOURCES = 200;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOURCE_DIRECTORIES = ['references', 'scripts', 'assets'] as const;

export interface LoadSkillFileOptions {
  /** Maximum size of the `SKILL.md` file. */
  maxBytes?: number;
  /** Maximum size of one resource loaded on demand. */
  maxResourceBytes?: number;
}

/**
 * Loads one explicit `SKILL.md` file.
 *
 * Only `name` and `description` are advertised up front. The body and any
 * files under `references/`, `scripts/` or `assets/` load on demand.
 */
export async function loadSkillFile(
  path: string,
  options: LoadSkillFileOptions = {},
): Promise<ProgressiveSkillProvider> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxResourceBytes = options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
  assertPositiveInteger(maxBytes, 'maxBytes');
  assertPositiveInteger(maxResourceBytes, 'maxResourceBytes');

  const absolute = await realpath(resolve(path));
  const info = await stat(absolute);
  if (info.size > maxBytes) {
    throw new Error(`Skill file "${path}" exceeds ${maxBytes} bytes`);
  }
  const source = (await readFile(absolute, 'utf8')).replace(/^\uFEFF/, '');
  if (Buffer.byteLength(source) > maxBytes) {
    throw new Error(`Skill file "${path}" exceeds ${maxBytes} bytes`);
  }
  const skill = parseSkillFile(source, path);
  const root = dirname(absolute);

  return defineContextProvider({
    name: skill.name,
    description: skill.description,
    async read() {
      return [{ id: `${skill.name}:metadata`, content: skill.description }];
    },
    async load(_context: KnowledgeContext, resource?: string) {
      if (resource !== undefined) {
        return [
          {
            id: `${skill.name}:resource:${resource}`,
            content: await readResource(root, resource, maxResourceBytes),
          },
        ];
      }
      const blocks: ContextBlock[] = [
        { id: `${skill.name}:instructions`, content: skill.instructions },
      ];
      const resources = await listResources(root);
      if (resources.length) {
        blocks.push({
          id: `${skill.name}:resources`,
          content: [
            'Resources:',
            ...resources.map((item) => `- ${item.path} (${formatBytes(item.size)})`),
            'Load one by passing its path as the resource argument.',
            ...(resources.some((item) => item.path.startsWith('scripts/'))
              ? ['Scripts are for reference only and are not executed by this runtime.']
              : []),
          ].join('\n'),
        });
      }
      return blocks;
    },
  });
}

/** Loads several explicit `SKILL.md` files; it never scans directories. */
export function loadSkillFiles(
  paths: readonly string[],
  options: LoadSkillFileOptions = {},
): Promise<ProgressiveSkillProvider[]> {
  return Promise.all(paths.map((path) => loadSkillFile(path, options)));
}

function parseSkillFile(
  source: string,
  path: string,
): { name: string; description: string; instructions: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) {
    throw new Error(`Skill file "${path}" must start with --- frontmatter`);
  }
  const fields = parseFrontmatter(match[1]!);
  const name = fields.name?.trim();
  const description = fields.description?.trim();
  const instructions = match[2]!.trim();
  if (!name) throw new Error(`Skill file "${path}" must define a name`);
  if (name.length > 64 || !SKILL_NAME.test(name) || name.startsWith('fevex__')) {
    throw new Error(
      `Skill file "${path}" has an invalid name; use lowercase letters, numbers and hyphens, up to 64 characters`,
    );
  }
  if (!description) throw new Error(`Skill file "${path}" must define a description`);
  if (!instructions) throw new Error(`Skill file "${path}" must contain instructions`);
  return { name, description, instructions };
}

function parseFrontmatter(source: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!;
        if (next.trim() && !/^\s/.test(next)) break;
        index += 1;
        block.push(next.replace(/^\s+/, ''));
      }
      while (block.length && !block[block.length - 1]) block.pop();
      value = value.startsWith('>')
        ? block.filter(Boolean).join(' ')
        : block.join('\n');
    } else if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

interface SkillResource {
  path: string;
  size: number;
}

async function listResources(root: string): Promise<SkillResource[]> {
  const resources: SkillResource[] = [];
  for (const directory of RESOURCE_DIRECTORIES) {
    await walkResources(resolve(root, directory), root, resources);
  }
  return resources
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, MAX_RESOURCES);
}

async function walkResources(
  directory: string,
  root: string,
  resources: SkillResource[],
): Promise<void> {
  if (resources.length >= MAX_RESOURCES) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (resources.length >= MAX_RESOURCES) return;
    if (entry.isSymbolicLink()) continue;
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walkResources(target, root, resources);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(target);
    resources.push({
      path: relative(root, target).split('\\').join('/'),
      size: info.size,
    });
  }
}

async function readResource(root: string, resource: string, maxBytes: number): Promise<string> {
  if (resource.includes('\0')) {
    throw new Error('Skill resource path is invalid');
  }
  const requested = resolve(root, resource);
  const requestedPath = relative(root, requested);
  if (!requestedPath || requestedPath.startsWith('..') || isAbsolute(requestedPath)) {
    throw new Error(`Skill resource "${resource}" is outside the skill directory`);
  }
  let target: string;
  try {
    target = await realpath(requested);
  } catch {
    throw new Error(`Skill resource "${resource}" was not found`);
  }
  const path = relative(root, target);
  if (!path || path.startsWith('..') || isAbsolute(path)) {
    throw new Error(`Skill resource "${resource}" is outside the skill directory`);
  }
  const info = await stat(target);
  if (!info.isFile()) {
    throw new Error(`Skill resource "${resource}" is not a file`);
  }
  if (info.size > maxBytes) {
    throw new Error(`Skill resource "${resource}" exceeds ${maxBytes} bytes`);
  }
  const buffer = await readFile(target);
  if (buffer.includes(0)) {
    throw new Error(`Skill resource "${resource}" is not UTF-8 text`);
  }
  return buffer.toString('utf8');
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Skill ${name} must be a positive safe integer`);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
  );
}
