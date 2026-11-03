import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createFevex,
  defineAgent,
  FevexRunError,
  type ModelGateway,
} from '@fevex/core';
import { createSQLiteRunStore } from '@fevex/sqlite';

const workerScript = fileURLToPath(new URL('./soak-recovery-worker.ts', import.meta.url));
const usage = 'bun run soak:recovery -- [--lease-wait-ms 31000]';

export interface RecoveryOptions {
  leaseWaitMs?: number;
}

export interface RecoveryReport {
  schemaVersion: '1';
  pass: boolean;
  runId: string;
  recoveredOutput?: string;
  recoveredAfterMs: number;
  eventCount: number;
  runStarts: number;
  recoveredEvent: boolean;
  leaseWaitMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workerStarted(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let runId = '';
    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error(`Recovery worker did not start within ${timeoutMs}ms`));
    }, timeoutMs);
    const settle = () => {
      if (!runId || !ready) return;
      clearTimeout(timer);
      resolve(runId);
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
      reject(new Error(`Recovery worker exited before READY (code ${code ?? 'unknown'})`));
    });
  });
}

export async function runRecovery(options: RecoveryOptions = {}): Promise<RecoveryReport> {
  const leaseWaitMs = options.leaseWaitMs ?? 31_000;
  if (!Number.isSafeInteger(leaseWaitMs) || leaseWaitMs < 1) {
    throw new TypeError('leaseWaitMs must be a positive safe integer');
  }
  const directory = mkdtempSync(join(tmpdir(), 'fevex-recovery-'));
  const database = join(directory, 'recovery.sqlite');
  const child = spawn('bun', ['run', workerScript, database], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let runId = '';
  let runStore: ReturnType<typeof createSQLiteRunStore> | undefined;
  try {
    runId = await workerStarted(child, 15_000);
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    child.kill('SIGKILL');
    await exited;

    runStore = createSQLiteRunStore({ filename: database });
    const model: ModelGateway = {
      async *stream() {
        yield { type: 'output.delta', delta: 'recovered' };
        yield { type: 'completed', result: { output: 'recovered' } };
      },
    };
    const app = createFevex({
      models: { default: model },
      agents: [defineAgent({
        name: 'recovery-worker',
        instructions: 'Wait for a recoverable checkpoint.',
      })],
      runStore,
    });

    const recoveryStarted = Date.now();
    const deadline = recoveryStarted + leaseWaitMs;
    let recovered = false;
    while (Date.now() < deadline) {
      try {
        await app.recoverRun(runId, { actor: { id: 'recovery-worker' } });
        recovered = true;
        break;
      } catch (error) {
        if (
          !(error instanceof FevexRunError)
          || (error.code !== 'RUN_CONFLICT' && error.code !== 'RUN_NOT_RECOVERABLE')
        ) {
          throw error;
        }
        await sleep(500);
      }
    }
    if (!recovered) throw new Error(`Run "${runId}" was not recoverable within ${leaseWaitMs}ms`);

    let run = await app.getRun(runId);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (run?.status === 'completed') break;
      if (run?.status === 'failed' || run?.status === 'cancelled' || run?.status === 'paused') {
        throw new Error(`Recovered run ended as ${run.status}: ${run.error ?? ''}`);
      }
      await sleep(25);
      run = await app.getRun(runId);
    }
    if (run?.status !== 'completed') {
      throw new Error(`Recovered run did not complete (status ${run?.status ?? 'missing'})`);
    }

    const events = await app.listEvents(runId, { limit: 1_000 });
    const runStarts = events.filter(({ type }) => type === 'run.started').length;
    const recoveredEvent = events.some(({ type }) => type === 'run.recovered');
    const ordered = events.every(
      (event, index) => index === 0 || event.sequence === events[index - 1]!.sequence + 1,
    );
    const output = run.output;
    const pass = runStarts === 1
      && recoveredEvent
      && ordered
      && events.at(-1)?.type === 'run.completed'
      && output === 'recovered';
    const report: RecoveryReport = {
      schemaVersion: '1',
      pass,
      runId,
      recoveredOutput: typeof output === 'string' ? output : undefined,
      recoveredAfterMs: Date.now() - recoveryStarted,
      eventCount: events.length,
      runStarts,
      recoveredEvent,
      leaseWaitMs,
    };
    return report;
  } finally {
    await runStore?.close();
    child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'lease-wait-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const leaseWaitMs = values['lease-wait-ms'] === undefined
    ? undefined
    : Number(values['lease-wait-ms']);
  const report = await runRecovery({ leaseWaitMs });
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
