import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, internalDependencies, loadPackage, orderPackages, selectBatch, selectNpmBatch, parseVersion, readRegistry, recordReleases, registryStatus, selectPackage, validateContents, waitForRegistryVisibility } from './release.mjs';

const manifest = {
  name: '@fevex/core', version: '0.1.0-alpha.2',
  publishConfig: { access: 'public' },
  repository: { url: 'git+https://github.com/hemia-labs/fevex.git' },
  exports: { '.': { types: './dist/index.d.mts', import: './dist/index.mjs' } },
};
const candidates = [{ directory: 'packages/fevex', manifest }];
const selected = selectPackage('@fevex/core@0.1.0-alpha.2', candidates);
const release = { integrity: 'sha512-fixture' };
const files = ['package.json', 'README.md', 'dist/index.d.mts', 'dist/index.mjs'];

describe('release selection and tarball contents', () => {
  test('maps the published core name to its actual directory', () => {
    expect(selectPackage('@fevex/core@0.1.0-alpha.2', candidates).directory).toBe('packages/fevex');
  });
  test.each(['alpha', 'beta', 'rc'])('maps %s to its own channel', (channel) => {
    expect(parseVersion(`1.2.3-${channel}.0`).channel).toBe(channel);
  });
  test('only stable versions use latest', () => {
    expect(parseVersion('1.2.3').channel).toBe('latest');
  });
  test('publishes alpha versions on the npm latest tag', () => {
    expect(selected.npmTag).toBe('latest');
  });
  test.each(['01.2.3', '1.2.3-alpha.01', '1.2.3-preview.1', '1.2.3-alpha', '1.2.3+build', 'v1.2.3', '1.2.3;echo injected', '9007199254740992.0.0'])('rejects unsupported version %s', (version) => {
    expect(() => parseVersion(version)).toThrow();
  });
  test.each(['@fevex/missing@0.1.0-alpha.2', '@fevex/core@0.1.0-alpha.3', '../../core@0.1.0-alpha.2', '@fevex/core@$(id)'])('rejects invalid target %s', (tag) => {
    expect(() => selectPackage(tag, candidates)).toThrow();
  });
  test('rejects private packages and alternative registries', () => {
    expect(() => selectPackage(selected.tag, [{ ...candidates[0], manifest: { ...manifest, private: true } }])).toThrow();
    expect(() => selectPackage(selected.tag, [{ ...candidates[0], manifest: { ...manifest, publishConfig: { access: 'public', registry: 'https://example.com' } } }])).toThrow();
  });
  test('includes peer dependencies in release ordering', () => {
    expect(internalDependencies({ peerDependencies: { '@fevex/core': '0.1.0-alpha.2', '@opentelemetry/api': '^1.9.0' } })).toEqual([['@fevex/core', '0.1.0-alpha.2']]);
  });
  test('requires every declared export in the package and excludes local files', () => {
    expect(() => validateContents(manifest, files)).not.toThrow();
    expect(() => validateContents(manifest, files.slice(0, -1))).toThrow('Missing export');
    expect(() => validateContents(manifest, [...files, '.env'])).toThrow('Unexpected file');
    expect(() => validateContents(manifest, [...files, 'src/index.ts'])).toThrow('Unexpected file');
    expect(() => validateContents(manifest, [...files, 'dist/../secret'])).toThrow('Unexpected file');
    expect(() => validateContents({ ...manifest, dependencies: { '@fevex/core': 'workspace:*' } }, files)).toThrow('Local dependency');
  });
  test('compares numeric prereleases and stable versions correctly', () => {
    expect(compareVersions('0.1.0-alpha.10', '0.1.0-alpha.2')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.0-rc.99')).toBe(1);
    expect(compareVersions('0.1.0-beta.0', '0.1.0-alpha.99')).toBe(1);
    expect(compareVersions('0.1.0', '0.2.0-alpha.0')).toBe(-1);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });
});

describe('registry preflight and safe retries', () => {
  const metadata = { versions: {}, 'dist-tags': { latest: '0.1.0-alpha.1' } };
  test('a new version can be published to an existing package', async () => {
    expect(await registryStatus(selected, release, async () => metadata)).toBe(false);
  });
  test('unknown packages require initial setup', async () => {
    await expect(registryStatus(selected, release, async () => null)).rejects.toThrow('initial authenticated publication');
  });
  test('does not regress a channel', async () => {
    await expect(registryStatus(selected, release, async () => ({ ...metadata, 'dist-tags': { latest: '0.1.0-alpha.10' } }))).rejects.toThrow('backwards');
  });
  test('an exact retry is a no-op, changed content fails', async () => {
    const existing = { versions: { [manifest.version]: { dist: { integrity: release.integrity } } }, 'dist-tags': { latest: manifest.version } };
    expect(await registryStatus(selected, release, async () => existing)).toBe(true);
    await expect(registryStatus(selected, { integrity: 'sha512-other' }, async () => existing)).rejects.toThrow('different content');
    await expect(registryStatus(selected, release, async () => ({ ...existing, 'dist-tags': {} }))).rejects.toThrow('channel differs');
  });
  test('waits for npm validation and a delayed dist-tag before recording a publish', async () => {
    const published = { versions: { [manifest.version]: { dist: { integrity: release.integrity } } }, 'dist-tags': { latest: manifest.version } };
    let reads = 0;
    let elapsed = 0;
    const options = {
      lookup: async () => ++reads === 1 ? metadata : reads === 2 ? { ...published, 'dist-tags': metadata['dist-tags'] } : published,
      sleep: async (ms: number) => { elapsed += ms; },
      now: () => elapsed,
      timeoutMs: 90_000,
    };
    expect(await waitForRegistryVisibility(selected, release, options)).toBe(true);
    expect([reads, elapsed]).toEqual([3, 60_000]);

    reads = 0;
    elapsed = 0;
    expect(await waitForRegistryVisibility(selected, release, { ...options, lookup: async () => { reads++; return metadata; }, timeoutMs: 60_000 })).toBe(false);
    expect([reads, elapsed]).toEqual([3, 60_000]);
  });
  test('requires the exact core version for adapters, including peers', async () => {
    const adapter = { ...selected, manifest: { ...manifest, name: '@fevex/opentelemetry', peerDependencies: { '@fevex/core': '0.1.0-alpha.2' } } };
    await expect(registryStatus(adapter, release, async () => metadata)).rejects.toThrow('Publish @fevex/core@0.1.0-alpha.2');
    const adapterRelease = { ...release, dependencies: [{ name: '@fevex/core', version: '0.1.0-alpha.2', integrity: 'sha512-core' }] };
    const lookup = async (name: string) => name === '@fevex/core' ? { versions: { '0.1.0-alpha.2': { dist: { integrity: 'sha512-core' } } } } : metadata;
    expect(await registryStatus(adapter, adapterRelease, lookup)).toBe(false);
    await expect(registryStatus(adapter, { ...adapterRelease, dependencies: [{ ...adapterRelease.dependencies[0], integrity: 'sha512-modified-core' }] }, lookup)).rejects.toThrow('differs from the tested local dependency');
  });
  test('only HTTP 404 means missing; network, auth and server errors fail', async () => {
    expect(await readRegistry('@fevex/core', async () => new Response('', { status: 404 }))).toBeNull();
    for (const status of [401, 403, 429, 500]) {
      await expect(readRegistry('@fevex/core', async () => new Response('', { status }))).rejects.toThrow(`HTTP ${status}`);
    }
    await expect(readRegistry('@fevex/core', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });
  test('batch preflight allows a planned dependency but never masks an existing artifact', async () => {
    const core = { name: manifest.name, version: manifest.version, integrity: 'sha512-core' };
    const adapterRelease = { ...release, dependencies: [core] };
    for (const name of ['@fevex/openai', '@fevex/deepseek']) {
      const adapter = { ...selected, manifest: { ...manifest, name, dependencies: { '@fevex/core': manifest.version } } };
      expect(await registryStatus(adapter, adapterRelease, async () => metadata, [core])).toBe(false);
      await expect(registryStatus(adapter, adapterRelease, async () => metadata, [{ ...core, integrity: 'sha512-other' }])).rejects.toThrow('differs from the tested local dependency');
      for (const published of [{}, { dist: { integrity: 'sha512-other' } }]) {
        const lookup = async (dependency: string) => dependency === core.name ? { versions: { [core.version]: published } } : metadata;
        await expect(registryStatus(adapter, adapterRelease, lookup, [core])).rejects.toThrow('differs from the tested local dependency');
      }
    }
  });
});

test('binds a tarball to its manifest, dependencies and integrity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fevex-release-test-'));
  try {
    mkdirSync(join(directory, 'package/dist'), { recursive: true });
    writeFileSync(join(directory, 'package/package.json'), JSON.stringify(manifest));
    writeFileSync(join(directory, 'package/dist/index.mjs'), 'export {};');
    writeFileSync(join(directory, 'package/dist/index.d.mts'), 'export {};');
    const filename = 'fevex-core-0.1.0-alpha.2.tgz';
    const tarball = join(directory, filename);
    execFileSync('tar', ['-czf', tarball, '-C', directory, 'package/package.json', 'package/dist/index.mjs', 'package/dist/index.d.mts']);
    const metadata = {
      name: manifest.name, version: manifest.version,
      filename, integrity: `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`, dependencies: [],
    };
    expect(loadPackage(selected, metadata, directory).tarball).toBe(tarball);
    for (const changed of [{ name: '@fevex/other' }, { version: '0.1.0' }, { filename: '../other.tgz' }, { integrity: 'wrong' }, { dependencies: [{ name: '@fevex/core', version: '0.1.0' }] }]) {
      expect(() => loadPackage(selected, { ...metadata, ...changed }, directory)).toThrow();
    }
    expect(() => loadPackage({ ...selected, manifest: { ...manifest, description: 'changed' } }, metadata, directory)).toThrow('manifest mismatch');
    writeFileSync(tarball, 'tampered');
    expect(() => loadPackage(selected, metadata, directory)).toThrow('integrity mismatch');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('orders internal dependencies and selects only reviewed, increasing versions', () => {
  const adapter = { directory: 'packages/openai', manifest: { ...manifest, name: '@fevex/openai', dependencies: { '@fevex/core': manifest.version } } };
  expect(orderPackages([adapter, candidates[0]]).map(p => p.manifest.name)).toEqual(['@fevex/core', '@fevex/openai']);
  expect(() => orderPackages([{ ...candidates[0], manifest: { ...manifest, dependencies: { '@fevex/openai': manifest.version } } }, adapter])).toThrow('Cyclic');
  const entries = [{ name: manifest.name, version: manifest.version }, { name: '@fevex/openai', version: manifest.version }];
  const plan = [{ name: manifest.name, version: manifest.version, oldVersion: '0.1.0-alpha.1' }];
  expect(selectBatch(plan, entries)).toEqual([entries[0]]);
  expect(() => selectBatch([], entries)).toThrow();
  expect(() => selectBatch([...plan, ...plan], entries)).toThrow('Duplicate');
  expect(() => selectBatch([{ ...plan[0], version: '0.1.0-alpha.3' }], entries)).toThrow('does not match');
  expect(() => selectBatch([{ ...plan[0], oldVersion: manifest.version }], entries)).toThrow('increase');
});

test('publishes only core, DeepSeek and OpenAI in dependency order', () => {
  const names = ['@fevex/core', '@fevex/browser', '@fevex/deepseek', '@fevex/openai'];
  const entries = names.map(name => ({ name, version: manifest.version }));
  const plan = names.map(name => ({ name, version: manifest.version, oldVersion: '0.1.0-alpha.1' }));
  expect(selectNpmBatch(plan, entries).map(p => p.name)).toEqual(['@fevex/core', '@fevex/deepseek', '@fevex/openai']);
  expect(selectNpmBatch([plan[1]], entries)).toEqual([]);
});

test('records one alpha tag and prerelease per verified package, safely on retry', async () => {
  const commit = 'a'.repeat(40);
  const published = { commit, packages: [{ name: manifest.name, version: manifest.version, integrity: release.integrity }] };
  const plan = [{ name: manifest.name, version: manifest.version }, { name: '@fevex/browser', version: manifest.version }];
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let tagExists = false;
  let releaseExists = false;
  const api = async (path: string, body?: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path.startsWith('git/ref/tags/')) return tagExists ? { object: { type: 'commit', sha: commit } } : null;
    if (path === 'git/refs') { tagExists = true; return {}; }
    if (path.startsWith('releases/tags/')) return releaseExists ? { tag_name: manifest.name + '@' + manifest.version } : null;
    if (path === 'releases') { releaseExists = true; return {}; }
    throw new Error(`Unexpected GitHub API call: ${path}`);
  };
  await recordReleases(published, plan, commit, api);
  expect(calls.filter(call => call.body)).toEqual([
    { path: 'git/refs', body: { ref: `refs/tags/${manifest.name}@${manifest.version}`, sha: commit } },
    { path: 'releases', body: {
      tag_name: `${manifest.name}@${manifest.version}`, name: `${manifest.name}@${manifest.version}`,
      prerelease: true, make_latest: 'false',
      body: `Published from ${commit}.\n\nIntegrity: ${release.integrity}\n\nSee the package CHANGELOG.md at this commit.`,
    } },
  ]);
  await recordReleases(published, plan, commit, api);
  expect(calls.filter(call => call.body)).toHaveLength(2);
  await expect(recordReleases(published, [], commit, api)).rejects.toThrow('inventory mismatch');
  await expect(recordReleases(published, plan, 'b'.repeat(40), api)).rejects.toThrow('commit mismatch');
  await expect(recordReleases(published, plan, commit, async (path: string) => path.startsWith('git/ref/') ? { object: { type: 'commit', sha: 'b'.repeat(40) } } : null)).rejects.toThrow('Existing tag differs');
});
