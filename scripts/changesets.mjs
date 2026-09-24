import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmPackages } from './release.mjs';

const planFile = '.changeset/release-plan.json';
const cli = fileURLToPath(new URL('../node_modules/@changesets/cli/bin.js', import.meta.url));
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function publicPackages() {
  return readdirSync('packages', { withFileTypes: true }).filter(d => d.isDirectory())
    .map(d => ({ directory: `packages/${d.name}`, ...json(`packages/${d.name}/package.json`) }))
    .filter(p => !p.private);
}

export function versionPlan(before, after) {
  return after.filter(p => !p.private && before.find(old => old.name === p.name)?.version !== p.version)
    .map(p => ({ name: p.name, oldVersion: before.find(old => old.name === p.name)?.version, version: p.version }));
}

export function validateVersionDiff(files, plan, before, after) {
  assert(plan.length > 0, 'Release plan must not be empty');
  assert(files.every(path => /^(packages\/[^/]+\/(package\.json|CHANGELOG\.md)|examples\/[^/]+\/package\.json|apps\/[^/]+\/package\.json|bun\.lock|\.changeset\/(pre\.json|release-plan\.json|(?:pre\/)?[a-z0-9-]+\.md))$/.test(path)), `A release PR must contain only generated versions, changelogs and lockfile changes: ${files.join(', ')}`);
  assert.deepEqual(plan, versionPlan(before, after), 'Release plan must match all version changes');
}

export function changedPublicPackages(files, candidates) {
  return candidates.filter(p => files.some(path => path.startsWith(`${p.directory}/`) &&
    !/\.(test|test-d|spec)\.[cm]?[jt]sx?$/.test(path) &&
    !/\/(tests?|__tests__)\//.test(path) &&
    (path === `${p.directory}/package.json` || path === `${p.directory}/README.md` || /\.[cm]?[jt]sx?$/.test(path))))
    .map(p => p.name);
}

function changesetStatus(base) {
  const temporary = mkdtempSync(join(tmpdir(), 'fevex-changesets-'));
  try {
    const output = join(temporary, 'status.json');
    execFileSync('node', [cli, 'status', ...(base ? ['--since', base] : []), '--output', output], { stdio: 'inherit' });
    return json(output);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function version() {
  const before = publicPackages();
  execFileSync('node', [cli, 'version'], { stdio: 'inherit' });
  const releases = versionPlan(before, publicPackages());
  assert(releases.length > 0, 'Changesets did not produce a public release');
  writeFileSync(planFile, `${JSON.stringify({ releases }, null, 2)}\n`);
  execFileSync('bun', ['install', '--lockfile-only'], { stdio: 'inherit' });
}

function releaseDiff(base) {
  assert(/^[a-f0-9]{40}$/.test(base), 'Expected a full base commit SHA');
  const files = git(['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
  if (!files.includes(planFile)) return { pending: false, publishable: false, files };
  const after = publicPackages();
  const before = after.map(p => JSON.parse(git(['show', `${base}:${p.directory}/package.json`])));
  const plan = json(planFile).releases;
  validateVersionDiff(files, plan, before, after);
  return { pending: true, publishable: plan.some(p => npmPackages.has(p.name)), files };
}

function check(base) {
  const { pending, files } = releaseDiff(base);
  if (pending) return console.log('Release PR: version plan verified.');
  const changed = changedPublicPackages(files, publicPackages());
  if (!changed.length && !files.some(path => path !== '.changeset/README.md' && /^\.changeset\/.*\.md$/.test(path))) return;
  const status = changesetStatus(base);
  const covered = new Set(status.changesets.flatMap(change => change.releases.map(p => p.name)));
  const missing = changed.filter(name => !covered.has(name));
  assert(!missing.length, `Add a changeset for: ${missing.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, base] = process.argv.slice(2);
  if (command === 'version') version();
  else if (command === 'check') check(base);
  else if (command === 'batch') {
    const { pending, publishable } = releaseDiff(base);
    console.log(`Reviewed release batch: ${pending}; npm targets: ${publishable}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pending=${pending}\npublishable=${publishable}\n`);
  } else throw new Error('Usage: node scripts/changesets.mjs <version|check BASE_SHA|batch BASE_SHA>');
}
