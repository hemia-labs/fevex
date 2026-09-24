import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { changedPublicPackages, validateVersionDiff, versionPlan } from './changesets.mjs';

test('only public changes require coverage; release batches cannot hide source edits', () => {
  const before = [{ name: '@fevex/core', directory: 'packages/fevex', version: '0.1.0-alpha.1' }];
  const after = [{ ...before[0], version: '0.1.0-alpha.2' }];
  const plan = versionPlan(before, after);
  expect(changedPublicPackages(['packages/fevex/src/index.test.ts'], before)).toEqual([]);
  expect(changedPublicPackages(['packages/fevex/src/index.ts', 'packages/fevex/README.md'], before)).toEqual(['@fevex/core']);
  expect(() => validateVersionDiff(['.changeset/release-plan.json', 'packages/fevex/package.json'], plan, before, after)).not.toThrow();
  expect(() => validateVersionDiff(['.changeset/release-plan.json', '.changeset/release-example.md', '.changeset/pre/release-example.md', 'packages/fevex/package.json'], plan, before, after)).not.toThrow();
  expect(() => validateVersionDiff(['packages/fevex/src/index.ts'], plan, before, after)).toThrow('only generated');
  expect(() => validateVersionDiff([], [], before, after)).toThrow('empty');
  expect(() => validateVersionDiff([], plan, before, before)).toThrow('match all version');
});

for (const target of ['@fevex/openai', '@fevex/browser', '@fevex/core']) {
  test(`real Changesets + Bun: ${target} alpha release, exact peers, private workspaces and consumed changesets`, () => {
    const root = resolve('.');
    const fixture = mkdtempSync(join(tmpdir(), 'fevex-version-'));
    const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const read = (path: string) => JSON.parse(readFileSync(join(fixture, path), 'utf8'));
    const commit = () => { run('git', ['add', '.']); run('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', 'commit', '-qm', 'test']); return run('git', ['rev-parse', 'HEAD']); };
    try {
      for (const path of ['package.json', 'bun.lock', '.changeset/config.json', '.changeset/pre.json', ...['packages', 'apps', 'examples'].flatMap(parent => readdirSync(parent, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(`${parent}/${d.name}/package.json`)).map(d => `${parent}/${d.name}/package.json`))]) {
        mkdirSync(dirname(join(fixture, path)), { recursive: true });
        copyFileSync(join(root, path), join(fixture, path));
      }
      const source = target === '@fevex/browser' ? 'packages/browser/src/index.ts' : 'packages/openai/src/index.ts';
      mkdirSync(dirname(join(fixture, source)), { recursive: true });
      writeFileSync(join(fixture, source), 'export const example = 1;');
      run('git', ['init', '-b', 'main']);
      const initial = commit();
      const beforeCore = read('packages/fevex/package.json').version;
      writeFileSync(join(fixture, '.changeset/release-example.md'), `---\n"${target}": patch\n---\n\nTest release.\n`);
      if (target !== '@fevex/core') writeFileSync(join(fixture, source), 'export const example = 2;');
      const sourceCommit = commit();
      run('node', [join(root, 'scripts/changesets.mjs'), 'check', initial]);
      run('node', [join(root, 'scripts/changesets.mjs'), 'version']);
      const plan = read('.changeset/release-plan.json').releases;
      expect(plan.length).toBe(target === '@fevex/core' ? 9 : 1);
      expect(plan.every((p: {version: string}) => /-alpha\.\d+$/.test(p.version))).toBe(true);
      expect(read('.changeset/pre.json').mode).toBe('pre');
      expect(read('.changeset/pre.json').tag).toBe('alpha');
      if (target === '@fevex/core') {
        const core = read('packages/fevex/package.json').version;
        expect(core).not.toBe(beforeCore);
        expect(read('packages/openai/package.json').dependencies['@fevex/core']).toBe(core);
        expect(read('packages/deepseek/package.json').dependencies['@fevex/core']).toBe(core);
        expect(read('packages/opentelemetry/package.json').peerDependencies['@fevex/core']).toBe(core);
      } else expect(read('packages/fevex/package.json').version).toBe(beforeCore);
      expect(read('apps/web/package.json').version).toBeUndefined();
      expect(read('examples/nest-api/package.json').version).toBeUndefined();
      expect(existsSync(join(fixture, 'apps/web/CHANGELOG.md'))).toBe(false);
      expect(existsSync(join(fixture, 'packages/openai/CHANGELOG.md'))).toBe(target !== '@fevex/browser');
      const firstLock = readFileSync(join(fixture, 'bun.lock'), 'utf8');
      run('bun', ['install', '--lockfile-only', '--frozen-lockfile']);
      expect(readFileSync(join(fixture, 'bun.lock'), 'utf8')).toBe(firstLock);
      commit();
      expect(run('node', [join(root, 'scripts/changesets.mjs'), 'batch', sourceCommit])).toContain(`npm targets: ${target !== '@fevex/browser'}`);
      run('node', [join(root, 'scripts/changesets.mjs'), 'check', sourceCommit]);
      const status = join(fixture, 'status.json');
      run('node', [join(root, 'node_modules/@changesets/cli/bin.js'), 'status', '--output', status]);
      expect(read('status.json').releases).toEqual([]);
      expect(existsSync(join(fixture, '.changeset/release-example.md'))).toBe(false);
      expect(existsSync(join(fixture, '.changeset/pre/release-example.md'))).toBe(true);
      if (target === '@fevex/openai') {
        const firstVersion = read('packages/openai/package.json').version;
        writeFileSync(join(fixture, '.changeset/another-fix.md'), '---\n"@fevex/openai": patch\n---\n\nAnother fix.\n');
        writeFileSync(join(fixture, 'packages/openai/src/index.ts'), 'export const example = 3;');
        const nextSourceCommit = commit();
        run('node', [join(root, 'scripts/changesets.mjs'), 'version']);
        expect(read('packages/openai/package.json').version).not.toBe(firstVersion);
        expect(existsSync(join(fixture, '.changeset/another-fix.md'))).toBe(false);
        expect(existsSync(join(fixture, '.changeset/pre/another-fix.md'))).toBe(true);
        expect(existsSync(join(fixture, '.changeset/pre/release-example.md'))).toBe(true);
        commit();
        expect(run('node', [join(root, 'scripts/changesets.mjs'), 'batch', nextSourceCommit])).toContain('true');
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, 60_000);
}
