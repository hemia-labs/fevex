import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const pilotFiles = [
  'support-pilot.mjs',
  'research-pilot.mjs',
  'crash-worker.mjs',
  'crash-recover.mjs',
];
const usage = `bun run pilots -- [options]

Options:
  --skip-recovery          Skip the SIGKILL recovery pilot
  --recovery-wait-ms <ms>  Wait for the run lease before recovery. Default: 31000
  --report <path>          Evidence report. Default: pilots/reports/latest.json
  --keep                   Keep the temporary consumer directory
  --help                   Show this help`;

interface ReleaseEntry {
  name: string;
  version: string;
  filename: string;
}

interface PilotEvidence {
  pilot: string;
  pass: boolean;
  error?: string;
  steps?: Array<{ name: string; at: string }>;
  [key: string]: unknown;
}

export interface PilotReport {
  schemaVersion: '1';
  commit: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  source: {
    kind: 'clean-tarball-consumer';
    workingTreeDirty: boolean;
    packages: Array<{ name: string; version: string }>;
  };
  pilots: PilotEvidence[];
  recovery?: PilotEvidence;
  observations: string[];
  pass: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'unknown'}`);
  }
}

function readEvidence(path: string): PilotEvidence {
  if (!existsSync(path)) {
    return { pilot: 'missing', pass: false, error: `Evidence file not written: ${path}` };
  }
  return JSON.parse(readFileSync(path, 'utf8')) as PilotEvidence;
}

function runPilot(name: string, consumer: string): PilotEvidence {
  const evidenceFile = `${name}-evidence.json`;
  const result = spawnSync('node', [`${name}-pilot.mjs`, evidenceFile], {
    cwd: consumer,
    stdio: 'inherit',
    env: process.env,
  });
  const evidence = readEvidence(join(consumer, evidenceFile));
  if (result.error) evidence.error = result.error.message;
  if (result.status !== 0 && !evidence.error) {
    evidence.error = `${name} pilot exited with ${result.status ?? 'unknown'}`;
  }
  evidence.pass = result.status === 0 && evidence.pass === true;
  return evidence;
}

function waitForWorker(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<string> {
  return new Promise((resolveWorker, reject) => {
    let buffer = '';
    let runId = '';
    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error(`Crash worker did not start within ${timeoutMs}ms`));
    }, timeoutMs);
    const settle = () => {
      if (!runId || !ready) return;
      clearTimeout(timer);
      resolveWorker(runId);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('RUN_ID ')) runId = line.slice('RUN_ID '.length).trim();
        if (line.trim() === 'READY') ready = true;
        settle();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (runId && ready) return;
      clearTimeout(timer);
      reject(new Error(`Crash worker exited before READY (code ${code ?? 'unknown'})`));
    });
  });
}

async function runRecovery(
  consumer: string,
  recoveryWaitMs: number,
): Promise<PilotEvidence> {
  const child = spawn('node', ['crash-worker.mjs', 'crash.sqlite'], {
    cwd: consumer,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let runId = '';
  try {
    runId = await waitForWorker(child, 15_000);
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    child.kill('SIGKILL');
    await exited;
    await sleep(recoveryWaitMs);
    const result = spawnSync('node', ['crash-recover.mjs', 'crash.sqlite', runId, 'crash-evidence.json'], {
      cwd: consumer,
      stdio: 'inherit',
      env: process.env,
    });
    const evidence = readEvidence(join(consumer, 'crash-evidence.json'));
    if (result.error) evidence.error = result.error.message;
    if (result.status !== 0 && !evidence.error) {
      evidence.error = `Recovery pilot exited with ${result.status ?? 'unknown'}`;
    }
    evidence.pass = result.status === 0 && evidence.pass === true;
    return evidence;
  } catch (error) {
    return {
      pilot: 'crash-recovery',
      pass: false,
      runId,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    child.kill('SIGKILL');
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'skip-recovery': { type: 'boolean', default: false },
      'recovery-wait-ms': { type: 'string' },
      report: { type: 'string' },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const recoveryWaitMs = values['recovery-wait-ms'] === undefined
    ? 31_000
    : Number(values['recovery-wait-ms']);
  if (!Number.isSafeInteger(recoveryWaitMs) || recoveryWaitMs < 0) {
    throw new TypeError('--recovery-wait-ms must be a non-negative safe integer');
  }
  const reportPath = values.report ?? 'pilots/reports/latest.json';
  const startedAt = new Date();
  const started = performance.now();
  const temporary = mkdtempSync(join(tmpdir(), 'fevex-pilots-'));
  const consumer = join(temporary, 'consumer');
  const release = join(temporary, 'release');

  try {
    run('node', [join(root, 'scripts/release.mjs'), 'build', release], root);
    const batch = JSON.parse(readFileSync(join(release, 'release.json'), 'utf8')) as {
      packages: ReleaseEntry[];
    };
    const required = ['@fevex/core', '@fevex/openai', '@fevex/deepseek', '@fevex/sqlite'];
    const packages = required.map((name) => {
      const entry = batch.packages.find((candidate) => candidate.name === name);
      if (!entry) throw new Error(`Release artifact is missing ${name}`);
      return entry;
    });

    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
    }, null, 2));
    run('npm', [
      'install',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--registry',
      'https://registry.npmjs.org',
      ...packages.map(({ filename }) => join(release, filename)),
    ], consumer);
    for (const file of pilotFiles) {
      copyFileSync(join(root, 'pilots', file), join(consumer, file));
    }

    const pilots = [
      runPilot('support', consumer),
      runPilot('research', consumer),
    ];
    const recovery = values['skip-recovery'] === true
      ? undefined
      : await runRecovery(consumer, recoveryWaitMs);

    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
      .stdout.trim();
    const workingTreeDirty = spawnSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout.trim().length > 0;
    const report: PilotReport = {
      schemaVersion: '1',
      commit,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      source: {
        kind: 'clean-tarball-consumer',
        workingTreeDirty,
        packages: packages.map(({ name, version }) => ({ name, version })),
      },
      pilots,
      ...(recovery ? { recovery } : {}),
      observations: [
        'Official packages were installed from locally built tarballs; @fevex/sqlite is repository-only.',
        'HTTP resume requires an authenticated actor supplied by the handler context.',
        'Workflow event resume preserves the parent run and child agent history.',
        'Crash recovery waits for the 30 second lease before acquiring the orphaned run.',
        'Upgrade is a documented manual pilot step; this harness validates install, operation and crash recovery.',
      ],
      pass: pilots.every(({ pass }) => pass) && (recovery?.pass ?? true),
    };
    const resolvedReport = resolve(root, reportPath);
    mkdirSync(dirname(resolvedReport), { recursive: true });
    writeFileSync(resolvedReport, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      report: reportPath,
      pass: report.pass,
      pilots: report.pilots.map(({ pilot, pass }) => ({ pilot, pass })),
      ...(report.recovery ? { recovery: report.recovery.pass } : {}),
      durationMs: report.durationMs,
    }, null, 2));
    if (!report.pass) process.exitCode = 1;
  } finally {
    if (values.keep !== true) rmSync(temporary, { recursive: true, force: true });
    else console.log(`Temporary consumer kept at ${consumer}`);
  }
}

await main();
