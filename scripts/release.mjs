import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = 'https://registry.npmjs.org';
const repository = 'git+https://github.com/hemia-labs/fevex.git';
export const npmPackages = new Set(['@fevex/core', '@fevex/deepseek', '@fevex/openai']);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const capture = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
const integrity = (path) => `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;

// Deliberately accept only the release channels documented for this repository.
export function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(version);
  assert(match, `Unsupported release version: ${version}`);
  const numbers = [match[1], match[2], match[3], match[5] ?? '0'].map(Number);
  assert(numbers.every(Number.isSafeInteger), 'Version numbers must be safe integers');
  return { channel: match[4] ?? 'latest', order: [...numbers.slice(0, 3), ['alpha', 'beta', 'rc', 'latest'].indexOf(match[4] ?? 'latest'), numbers[3]] };
}

export function compareVersions(a, b) {
  const left = parseVersion(a).order;
  const right = parseVersion(b).order;
  return left.map((value, i) => Math.sign(value - right[i])).find(Boolean) ?? 0;
}

export function packages() {
  return readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ directory: join(root, 'packages', entry.name), manifest: readJson(join(root, 'packages', entry.name, 'package.json')) }));
}

export function selectPackage(tag, candidates = packages()) {
  const match = /^(@fevex\/[a-z0-9-]+)@(.+)$/.exec(tag);
  assert(match, 'Expected @fevex/<package>@<version>');
  const versionChannel = parseVersion(match[2]).channel;
  const npmTag = versionChannel === 'alpha' ? 'latest' : versionChannel;
  const selected = candidates.find(({ manifest }) => manifest.name === match[1]);
  assert(selected, `Unknown package: ${match[1]}`);
  const { manifest } = selected;
  assert(!manifest.private && manifest.publishConfig?.access === 'public', 'Package must be public');
  assert.equal(manifest.version, match[2], 'Tag version must match package.json');
  assert.equal(manifest.repository?.url, repository, 'Unexpected package repository');
  assert(!manifest.publishConfig.registry || manifest.publishConfig.registry.replace(/\/$/, '') === registry, 'Unexpected registry');
  assert(!manifest.publishConfig.tag || manifest.publishConfig.tag === npmTag, 'Unexpected publishConfig.tag');
  return { ...selected, npmTag, tag };
}

export function internalDependencies(manifest) {
  const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
  return Object.entries(dependencies).filter(([name]) => name.startsWith('@fevex/'));
}

export function validateContents(manifest, files) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    assert(!Object.values(manifest[field] ?? {}).some((value) => /^(workspace:|file:|link:)/.test(value)), `Local dependency in ${field}`);
  }
  assert(files.every((path) => !path.split('/').includes('..') && /^(dist\/|package\.json$|CHANGELOG\.md$|README(?:\.[^/]+)?$|LICENSE(?:\.[^/]+)?$)/i.test(path)), 'Unexpected file in tarball');
  const targets = Object.values(manifest.exports ?? {}).flatMap((entry) => typeof entry === 'string' ? [entry] : Object.values(entry));
  assert(targets.length > 0, 'Package must declare exports');
  for (const target of [...targets, manifest.main, manifest.types].filter(Boolean)) {
    assert(typeof target === 'string' && target.startsWith('./dist/'), `Unsupported export: ${target}`);
    assert(files.includes(target.slice(2)), `Missing export in tarball: ${target}`);
  }
}

function pack(selected, destination) {
  mkdirSync(destination, { recursive: true });
  run('bun', ['run', '--cwd', selected.directory, 'build']);
  // Build explicitly so pack emits machine-readable JSON and never rebuilds the verified artifact.
  const [result] = JSON.parse(capture('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], selected.directory));
  validateContents(selected.manifest, result.files.map(({ path }) => path));
  return join(destination, result.filename);
}

function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
}

function filename(manifest) {
  return `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`;
}

function currentPlan() {
  const path = join(root, '.changeset/release-plan.json');
  return existsSync(path) ? readJson(path).releases : [];
}

export function orderPackages(candidates) {
  const ordered = [];
  const remaining = [...candidates];
  while (remaining.length) {
    const index = remaining.findIndex(p => internalDependencies(p.manifest).every(([name]) => !remaining.some(other => other.manifest.name === name)));
    assert(index !== -1, 'Cyclic internal package dependencies');
    ordered.push(...remaining.splice(index, 1));
  }
  return ordered;
}

async function build(destination) {
  const releases = [];
  for (const candidate of orderPackages(packages())) {
    const selected = selectPackage(`${candidate.manifest.name}@${candidate.manifest.version}`);
    const tarball = pack(selected, destination);
    const dependencies = internalDependencies(selected.manifest).map(([name, version]) => {
      const dependency = releases.find(p => p.name === name && p.version === version);
      assert(dependency, `Internal dependency ${name}@${version} must match its workspace manifest`);
      return { name, version, integrity: dependency.integrity };
    });
    releases.push({ name: selected.manifest.name, version: selected.manifest.version, filename: basename(tarball), integrity: integrity(tarball), dependencies });
  }
  writeFileSync(join(destination, 'release.json'), `${JSON.stringify({ commit: capture('git', ['rev-parse', 'HEAD']), plan: currentPlan(), packages: releases }, null, 2)}\n`);
  summary(`Built ${releases.length} packages once for commit ${capture('git', ['rev-parse', 'HEAD'])}.`);
}

export function loadPackage(selected, release, destination) {
  assert.equal(release.filename, filename(selected.manifest), 'Unexpected artifact filename');
  assert.equal(release.name, selected.manifest.name, 'Artifact package mismatch');
  assert.equal(release.version, selected.manifest.version, 'Artifact version mismatch');
  assert.deepEqual(release.dependencies.map(({ name, version }) => [name, version]), internalDependencies(selected.manifest), 'Artifact dependency mismatch');
  const tarball = join(destination, release.filename);
  assert.equal(integrity(tarball), release.integrity, 'Artifact integrity mismatch');
  const manifest = JSON.parse(capture('tar', ['-xOf', tarball, 'package/package.json']));
  assert.deepEqual(manifest, selected.manifest, 'Tarball manifest mismatch');
  validateContents(manifest, capture('tar', ['-tzf', tarball]).split('\n').map(path => path.replace(/^package\//, '')));
  return { ...release, tarball };
}

export function selectBatch(plan, releases) {
  assert(Array.isArray(plan) && plan.length, 'No reviewed release batch');
  assert.equal(new Set(plan.map(p => p.name)).size, plan.length, 'Duplicate package in release plan');
  return plan.map(p => {
    const release = releases.find(r => r.name === p.name && r.version === p.version);
    assert(release, `Release plan does not match artifact: ${p.name}@${p.version}`);
    assert(compareVersions(p.version, p.oldVersion) > 0, 'Release versions must increase');
    return release;
  });
}

export function selectNpmBatch(plan, releases) {
  const chosen = new Set(selectBatch(plan, releases).map(p => p.name));
  return releases.filter(p => chosen.has(p.name) && npmPackages.has(p.name));
}

function loadBatch(destination) {
  const batch = readJson(join(destination, 'release.json'));
  assert.equal(batch.commit, capture('git', ['rev-parse', 'HEAD']), 'Artifact commit mismatch');
  assert.deepEqual(batch.plan, currentPlan(), 'Artifact release plan mismatch');
  const candidates = orderPackages(packages());
  assert.deepEqual(batch.packages.map(p => p.name), candidates.map(p => p.manifest.name), 'Artifact inventory mismatch');
  return { ...batch, packages: batch.packages.map(p => loadPackage(selectPackage(`${p.name}@${p.version}`), p, destination)) };
}

function smoke(batch) {
  for (const release of batch.packages) {
    const dependencies = release.dependencies.map(d => {
      const artifact = batch.packages.find(p => p.name === d.name && p.version === d.version && p.integrity === d.integrity);
      assert(artifact, 'Tested dependency integrity mismatch');
      return artifact;
    });
    const consumer = mkdtempSync(join(tmpdir(), 'fevex-release-'));
    try {
      writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      run('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false', '--registry', registry, ...dependencies.map(d => d.tarball), release.tarball], consumer);
      const imports = [...dependencies, release].flatMap(p => Object.keys(selectPackage(`${p.name}@${p.version}`).manifest.exports).map(subpath => p.name + (subpath === '.' ? '' : subpath.slice(1))));
      writeFileSync(join(consumer, 'smoke.mjs'), `
        for (const name of ${JSON.stringify(imports)}) await import(name);
        if (${JSON.stringify(release.name)} === '@fevex/sqlite') {
          const { createSQLiteRunStore } = await import('@fevex/sqlite');
          const { testRunStore } = await import('@fevex/core/testing');
          const store = createSQLiteRunStore({ filename: ':memory:' });
          try { await testRunStore(store); } finally { await store.close(); }
        }
      `);
      run('node', ['smoke.mjs'], consumer);
      summary(`Clean consumer passed: **${release.name}@${release.version}**, Node ${process.versions.node}.`);
    } finally { rmSync(consumer, { recursive: true, force: true }); }
  }
}

export async function readRegistry(name, fetcher = fetch) {
  const response = await fetcher(`${registry}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  if (response.status === 404) return null;
  assert(response.ok, `Registry request failed for ${name}: HTTP ${response.status}`);
  return response.json();
}

export async function registryStatus(selected, release, lookup = readRegistry, planned = []) {
  const metadata = await lookup(selected.manifest.name);
  assert(metadata, 'Package does not exist in npm. Complete its initial authenticated publication and Trusted Publisher setup first.');
  const current = metadata['dist-tags']?.[selected.npmTag];
  assert(!current || compareVersions(current, selected.manifest.version) <= 0, `Refusing to move ${selected.npmTag} backwards from ${current}`);
  for (const [name, version] of internalDependencies(selected.manifest)) {
    parseVersion(version);
    const dependency = await lookup(name);
    const scheduled = planned.find(p => p.name === name && p.version === version);
    const published = dependency?.versions?.[version];
    assert(published || scheduled, `Publish ${name}@${version} before this package`);
    const tested = release.dependencies?.find((entry) => entry.name === name && entry.version === version);
    assert(tested?.integrity, `Missing tested artifact for ${name}@${version}`);
    assert.equal(published ? published.dist?.integrity : scheduled?.integrity, tested.integrity, `Published ${name}@${version} differs from the tested local dependency; bump its version`);
  }
  const existing = metadata.versions?.[selected.manifest.version];
  if (existing) {
    assert.equal(existing.dist?.integrity, release.integrity, 'Version already exists with different content; bump the version');
    assert.equal(current, selected.manifest.version, 'Version exists but its channel differs; review dist-tags manually');
  }
  return Boolean(existing);
}

async function publish(selected, release) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publishing is only allowed in GitHub Actions');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'Publishing requires a push to main');
  assert.equal(process.env.GITHUB_REPOSITORY, 'hemia-labs/fevex', 'Unexpected repository');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Publishing requires main');
  if (await registryStatus(selected, release)) {
    summary(`Already published and verified: **${selected.tag}**. No registry changes.`);
    return;
  }
  run('npm', ['publish', release.tarball, '--ignore-scripts', '--access', 'public', '--tag', selected.npmTag, '--registry', registry]);
  for (let attempt = 0; attempt < 6; attempt++) {
    // Only poll visibility after success; never retry a publish with an uncertain outcome.
    if (await registryStatus(selected, release)) {
      summary(`Published and verified **${selected.tag}** on **${selected.npmTag}**.`);
      return;
    }
    await setTimeout(5_000);
  }
  throw new Error('Publish succeeded but registry visibility could not be verified. Inspect npm before rerunning.');
}

async function publishBatch(batch, destination) {
  const ordered = selectNpmBatch(batch.plan, batch.packages);
  assert(ordered.length, 'No configured npm package in this release plan');
  // Check the entire batch before the first write; known bootstrap failures must not leave a partial release.
  for (const p of ordered) await registryStatus(selectPackage(`${p.name}@${p.version}`), p, readRegistry, ordered);
  const published = [];
  for (const p of ordered) {
    await publish(selectPackage(`${p.name}@${p.version}`), p);
    published.push({ name: p.name, version: p.version, integrity: p.integrity });
    writeFileSync(join(destination, 'published.json'), JSON.stringify({ commit: batch.commit, packages: published }, null, 2));
  }
}

export async function recordReleases(result, plan, commit, api) {
  assert.equal(result.commit, commit, 'Published commit mismatch');
  assert.deepEqual(result.packages.map(p => [p.name, p.version]).sort(), plan.filter(p => npmPackages.has(p.name)).map(p => [p.name, p.version]).sort(), 'Published inventory mismatch');
  for (const p of result.packages) {
    const tag = `${p.name}@${p.version}`;
    const ref = await api(`git/ref/tags/${encodeURIComponent(tag)}`);
    if (ref) assert(ref.object.type === 'commit' && ref.object.sha === result.commit, 'Existing tag differs; review manually');
    else await api('git/refs', { ref: `refs/tags/${tag}`, sha: result.commit });
    if (!await api(`releases/tags/${encodeURIComponent(tag)}`)) await api('releases', {
      tag_name: tag, name: tag, prerelease: parseVersion(p.version).channel !== 'latest',
      make_latest: parseVersion(p.version).channel === 'latest' ? 'true' : 'false',
      body: `Published from ${result.commit}.\n\nIntegrity: ${p.integrity}\n\nSee the package CHANGELOG.md at this commit.`,
    });
  }
}

async function record(destination) {
  const result = readJson(join(destination, 'published.json'));
  const api = async (path, body) => {
    const response = await fetch(`https://api.github.com/repos/hemia-labs/fevex/${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && !body) return null;
    assert(response.ok, `GitHub ${path}: HTTP ${response.status}`);
    return response.json();
  };
  await recordReleases(result, currentPlan(), capture('git', ['rev-parse', 'HEAD']), api);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, output] = process.argv.slice(2);
  assert(['build', 'smoke', 'inspect', 'publish', 'record'].includes(command) && output, 'Usage: node scripts/release.mjs <build|smoke|inspect|publish|record> <artifact-directory>');
  const destination = resolve(output);
  if (command === 'build') await build(destination);
  else if (command === 'record') await record(destination);
  else {
    const batch = loadBatch(destination);
    if (command === 'smoke') smoke(batch);
    else if (command === 'publish') await publishBatch(batch, destination);
    else {
      const chosen = batch.plan.length ? selectNpmBatch(batch.plan, batch.packages) : batch.packages.filter(p => npmPackages.has(p.name));
      if (!chosen.length) summary('No configured npm package in this release plan.');
      for (const p of chosen) {
        try {
          const exists = await registryStatus(selectPackage(`${p.name}@${p.version}`), p, readRegistry, chosen);
          summary(`${p.name}@${p.version}: ${exists ? 'already published' : 'registry preflight passed; OIDC not tested'}.`);
        } catch (error) {
          summary(`${p.name}@${p.version}: **not ready**. ${error.message}`);
        }
      }
      summary('Read-only rehearsal. Nothing published.');
    }
  }
}
