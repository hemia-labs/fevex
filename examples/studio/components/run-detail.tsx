'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { AgentEvent, RunRecord } from '@fevex/core';
import type { ApprovalRequest } from '@fevex/core/runtime';
import { buildTimeline, summarizeRun, type TimelineEntry } from '@/lib/events';
import {
  durationMs,
  errorMessage,
  formatDateTime,
  formatDuration,
  formatJson,
  formatNumber,
  formatRelative,
  runKind,
  runKindLabel,
  runModel,
  runName,
  shortId,
  statusLabel,
} from '@/lib/format';
import { createStudioClient } from '@/lib/studio-api';
import { StatusBadge } from './status-badge';
import { StudioHeader } from './studio-header';

type StreamState = 'connecting' | 'live' | 'closed' | 'error';

export function RunDetail({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunRecord>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [stream, setStream] = useState<StreamState>('connecting');
  const [loadError, setLoadError] = useState<string>();
  const [streamError, setStreamError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [deciding, setDeciding] = useState<'approve' | 'reject'>();
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await createStudioClient().getRun(runId);
        if (alive) {
          setRun(next);
          setLoadError(undefined);
        }
      } catch (error) {
        if (alive) setLoadError(errorMessage(error));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [runId, reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setEvents([]);
    setStream('connecting');
    setStreamError(undefined);

    void (async () => {
      try {
        for await (const event of createStudioClient().observeRun(runId, {
          signal: controller.signal,
        })) {
          if (!alive) break;
          setStream('live');
          setEvents((current) => current.some(({ id }) => id === event.id)
            ? current
            : [...current, event]);
        }
        if (alive) setStream('closed');
      } catch (error) {
        if (!alive || controller.signal.aborted) return;
        setStream('error');
        setStreamError(errorMessage(error));
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [runId, reloadKey]);

  const approval = approvalOf(run);
  const signals = useMemo(() => summarizeRun(events), [events]);
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const active = run?.status === 'running' || run?.status === 'paused';

  const decide = async (decision: 'approve' | 'reject') => {
    if (!approval || deciding) return;
    setDeciding(decision);
    try {
      await createStudioClient().resumeRun(runId, {
        type: 'approval',
        approvalId: approval.id,
        decision,
      });
      setReloadKey((value) => value + 1);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setDeciding(undefined);
    }
  };

  const cancel = async () => {
    if (!active || cancelling) return;
    setCancelling(true);
    try {
      await createStudioClient().cancelRun(runId);
      setReloadKey((value) => value + 1);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <StudioHeader>
        <Link className="button button-ghost" href="/">← Runs</Link>
      </StudioHeader>
      <main className="page">
        {(loadError || streamError) && (
          <div className="banner banner-danger" role="alert">
            <strong>Error de conexión.</strong>
            <p>{loadError ?? streamError}</p>
          </div>
        )}

        {!run ? (
          <section className="panel empty">
            <span className="spinner" aria-hidden="true" />
            <p className="muted">Cargando run…</p>
          </section>
        ) : (
          <>
            <section className="detail-heading">
              <div>
                <p className="eyebrow">
                  {runKindLabel(runKind(run))} · <code>{shortId(run.id)}</code>
                </p>
                <h1>{runName(run)}</h1>
                <div className="heading-meta">
                  <StatusBadge status={run.status} />
                  <span className="muted">
                    creado {formatDateTime(run.createdAt)}
                  </span>
                </div>
              </div>
              <div className="heading-actions">
                <button
                  className="button"
                  disabled={cancelling}
                  onClick={() => setReloadKey((value) => value + 1)}
                  type="button"
                >
                  {cancelling ? 'Cancelando…' : 'Recargar'}
                </button>
                {active && (
                  <button
                    className="button button-danger"
                    disabled={cancelling}
                    onClick={() => void cancel()}
                    type="button"
                  >
                    {cancelling ? 'Cancelando…' : 'Cancelar run'}
                  </button>
                )}
              </div>
            </section>

            <div className="detail-grid">
              <div className="detail-main">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Resultado</h2>
                    <span className="muted mono">
                      {formatDuration(durationMs(run))}
                    </span>
                  </div>
                  {run.error ? (
                    <pre className="output output-danger">{run.error}</pre>
                  ) : run.output !== undefined ? (
                    <pre className="output">{formatOutput(run.output)}</pre>
                  ) : (
                    <p className="muted">
                      {run.status === 'running'
                        ? 'El run sigue ejecutándose.'
                        : run.status === 'paused'
                          ? 'El run está pausado y todavía no tiene output.'
                          : 'Sin output registrado.'}
                    </p>
                  )}
                  {signals.failures.length > 0 && (
                    <div className="failures">
                      {signals.failures.map((failure) => (
                        <div className="failure" key={failure.id}>
                          <strong>{failure.source}</strong>
                          <p>{failure.message}</p>
                          {failure.code && <code>{failure.code}</code>}
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="panel">
                  <div className="panel-heading">
                    <h2>Timeline</h2>
                    <div className="panel-meta">
                      <StreamBadge state={stream} />
                      <span className="muted">{events.length} eventos</span>
                    </div>
                  </div>
                  {timeline.length === 0 ? (
                    <p className="muted">
                      {stream === 'connecting'
                        ? 'Conectando al stream de eventos…'
                        : 'Todavía no hay eventos.'}
                    </p>
                  ) : (
                    <div className="timeline">
                      {timeline.map((entry) => (
                        <TimelineRow entry={entry} key={entry.id} />
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <aside className="detail-side">
                {approval && (
                  <section className="panel approval-panel">
                    <div className="approval-title">
                      <p className="eyebrow">Aprobación pendiente</p>
                      <span className="badge tone-warning">
                        <span className="badge-dot" aria-hidden="true" />
                        Pendiente
                      </span>
                    </div>
                    <h2>{approval.toolLabel ?? approval.toolName}</h2>
                    <dl className="kv">
                      <div><dt>Riesgo</dt><dd>{approval.risk}</dd></div>
                      <div><dt>Solicitada</dt><dd>{formatRelative(approval.requestedAt)}</dd></div>
                      <div><dt>Approval</dt><dd className="mono">{shortId(approval.id)}</dd></div>
                    </dl>
                    <pre className="payload">{formatJson(approval.input)}</pre>
                    <div className="approval-actions">
                      <button
                        className="button button-primary"
                        disabled={deciding !== undefined}
                        onClick={() => void decide('approve')}
                        type="button"
                      >
                        {deciding === 'approve' ? 'Aprobando…' : 'Aprobar'}
                      </button>
                      <button
                        className="button button-danger"
                        disabled={deciding !== undefined}
                        onClick={() => void decide('reject')}
                        type="button"
                      >
                        {deciding === 'reject' ? 'Rechazando…' : 'Rechazar'}
                      </button>
                    </div>
                  </section>
                )}

                {run.pause && !approval && <PausePanel run={run} />}

                <section className="panel">
                  <h2>Run</h2>
                  <dl className="kv">
                    <div><dt>Estado</dt><dd>{statusLabel(run.status)}</dd></div>
                    <div><dt>Tipo</dt><dd>{runKindLabel(runKind(run))}</dd></div>
                    {runModel(run) && <div><dt>Modelo</dt><dd>{runModel(run)}</dd></div>}
                    <div><dt>Session</dt><dd className="mono">{shortId(run.sessionId)}</dd></div>
                    <div><dt>Creado</dt><dd>{formatDateTime(run.createdAt)}</dd></div>
                    <div><dt>Actualizado</dt><dd>{formatDateTime(run.updatedAt)}</dd></div>
                    <div><dt>Run ID</dt><dd className="mono wrap">{run.id}</dd></div>
                  </dl>
                  {run.usage && (
                    <>
                      <h3>Tokens</h3>
                      <dl className="kv">
                        <div><dt>Entrada</dt><dd>{formatNumber(run.usage.inputTokens)}</dd></div>
                        <div><dt>Salida</dt><dd>{formatNumber(run.usage.outputTokens)}</dd></div>
                        <div><dt>Total</dt><dd>{formatNumber(run.usage.totalTokens)}</dd></div>
                      </dl>
                    </>
                  )}
                </section>

                <section className="panel">
                  <h2>Tools</h2>
                  {signals.tools.length === 0 ? (
                    <p className="muted">Sin tools en este run.</p>
                  ) : (
                    <ul className="tool-list">
                      {signals.tools.map((tool) => (
                        <li key={tool.id}>
                          <span className={`tool-status tone-${tool.status === 'failed' ? 'danger' : tool.status === 'completed' ? 'success' : tool.status === 'retrying' ? 'warning' : 'info'}`} />
                          <div>
                            <strong>{tool.name}</strong>
                            <small className="muted">
                              {tool.status}
                              {tool.attempt ? ` · intento ${tool.attempt}` : ''}
                              {tool.source ? ` · ${tool.source}` : ''}
                            </small>
                            {tool.error && <p className="muted">{tool.error}</p>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </aside>
            </div>
          </>
        )}
      </main>
    </>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  return (
    <article className={`timeline-entry tone-${entry.severity}`}>
      <span className="timeline-dot" aria-hidden="true" />
      <div className="timeline-body">
        <header>
          <strong>{entry.title}</strong>
          {entry.count > 1 && <span className="pill">{entry.count} deltas</span>}
          <time className="muted" title={entry.timestamp}>
            {formatRelative(entry.timestamp)}
          </time>
        </header>
        {entry.type === 'model.output.delta' ? (
          <pre className="stream-output">{entry.detail}</pre>
        ) : entry.detail ? (
          <p className="event-detail">{entry.detail}</p>
        ) : null}
        {entry.payload !== undefined && entry.type !== 'model.output.delta' && (
          <details className="payload-details">
            <summary>Payload</summary>
            <pre>{formatJson(entry.payload)}</pre>
          </details>
        )}
      </div>
    </article>
  );
}

function PausePanel({ run }: { run: RunRecord }) {
  const pause = run.pause;
  if (!pause) return null;
  const content = (() => {
    switch (pause.type) {
      case 'elicitation':
        return {
          title: 'Elicitation pendiente',
          body: pause.request.prompt,
          extra: formatJson(pause.request.responseSchema),
        };
      case 'tool_execution_unknown':
        return {
          title: 'Ejecución incierta',
          body: `La tool ${pause.toolName} no confirmó su resultado.`,
          extra: formatJson(pause.input),
        };
      case 'workflow_timer':
        return {
          title: 'Timer pendiente',
          body: `El workflow se reanuda en ${pause.resumeAt}.`,
          extra: pause.stepId,
        };
      case 'workflow_event':
        return {
          title: 'Evento pendiente',
          body: `Esperando el evento ${pause.eventName}.`,
          extra: pause.stepId,
        };
      case 'workflow_child':
        return {
          title: 'Hijo pausado',
          body: `El child run ${pause.childRunId} está pausado.`,
          extra: pause.childPause.type,
        };
      case 'workflow_children':
        return {
          title: 'Hijos pausados',
          body: `${pause.children.length} child runs están pausados.`,
          extra: pause.children.map(({ stepId }) => stepId).join(', '),
        };
      case 'approval':
        return {
          title: 'Approval pendiente',
          body: pause.approval.toolLabel ?? pause.approval.toolName,
          extra: undefined,
        };
    }
  })();

  return (
    <section className="panel">
      <p className="eyebrow">Pausa</p>
      <h2>{content.title}</h2>
      <p className="muted">{content.body}</p>
      {content.extra && <pre className="payload">{content.extra}</pre>}
    </section>
  );
}

function StreamBadge({ state }: { state: StreamState }) {
  const label = {
    connecting: 'Conectando',
    live: 'En vivo',
    closed: 'Eventos cargados',
    error: 'Sin conexión',
  }[state];
  return <span className={`pill pill-${state}`}>{label}</span>;
}

function approvalOf(run?: RunRecord): ApprovalRequest | undefined {
  const pause = run?.pause;
  if (!pause) return undefined;
  if (pause.type === 'approval') return pause.approval;
  if (pause.type === 'workflow_child' && pause.childPause.type === 'approval') {
    return pause.childPause.approval;
  }
  if (pause.type === 'workflow_children') {
    const child = pause.children.find(({ childPause }) => childPause.type === 'approval');
    if (child?.childPause.type === 'approval') return child.childPause.approval;
  }
  return undefined;
}

function formatOutput(output: unknown): string {
  return typeof output === 'string' ? output : formatJson(output);
}
