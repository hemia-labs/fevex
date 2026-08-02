import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { RunStatus } from '@fevex/core';
import { FevexService } from './fevex.service';

const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_FPS = 1;
const MAX_CONSECUTIVE_ERRORS = 3;

/** Authenticated, read-only SSE stream of a run's browser preview frames. */
@Controller()
export class PreviewController {
  constructor(private readonly fevex: FevexService) {}

  @Get('v1/runs/:runId/preview')
  async preview(
    @Param('runId') runId: string,
    @Req() req: any,
    @Res() res: any,
  ): Promise<void> {
    const actor = header(req, 'x-fevex-actor') ?? this.fevex.demoActor;

    const run = await this.fevex.getRun(runId);
    if (!run) {
      problem(res, 404, 'RUN_NOT_FOUND', 'Run not found', runId);
      return;
    }
    if (actor !== this.fevex.getRunOwner(runId)) {
      problem(res, 403, 'RUN_FORBIDDEN', 'You do not own this run', runId);
      return;
    }

    const fps = clampFps(Number(process.env.FEVEX_PREVIEW_FPS));
    const intervalMs = Math.round(1000 / fps);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const controller = new AbortController();
    let closed = false;
    const stop = () => {
      closed = true;
      controller.abort();
    };
    res.on('close', stop);

    let errors = 0;
    try {
      while (!closed) {
        const current = await this.fevex.getRun(runId);
        if (!current || TERMINAL.has(current.status)) {
          write(res, 'end', { status: current?.status ?? 'gone' });
          break;
        }
        try {
          const frame = await this.fevex.previewFrameSource.capture(runId, controller.signal);
          errors = 0;
          write(res, 'frame', frame);
        } catch (error) {
          if (closed) break;
          errors += 1;
          write(res, 'error', { message: safeMessage(error) });
          if (errors >= MAX_CONSECUTIVE_ERRORS) break;
        }
        await sleep(intervalMs, controller.signal);
      }
    } catch {
      // aborted via client disconnect; fall through to cleanup
    } finally {
      res.off('close', stop);
      if (!res.writableEnded) res.end();
    }
  }
}

function header(req: any, name: string): string | undefined {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

function write(res: any, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function problem(res: any, status: number, code: string, detail: string, runId: string): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/problem+json');
  res.json({
    type: 'about:blank',
    title: code,
    status,
    code,
    detail,
    instance: `/v1/runs/${runId}/preview`,
  });
}

function clampFps(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_FPS;
  return Math.min(value, 10);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function safeMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'safeMessage' in error) {
    return String((error as { safeMessage: unknown }).safeMessage);
  }
  return 'preview capture failed';
}
