'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RunRecord, RunStatus } from '@fevex/core';
import {
  durationMs,
  errorMessage,
  formatDuration,
  formatRelative,
  previewValue,
  runKind,
  runKindLabel,
  runModel,
  runName,
  shortId,
} from '@/lib/format';
import { apiBaseUrl, createStudioClient } from '@/lib/studio-api';
import { StatusBadge } from './status-badge';

const FILTERS: Array<{ value?: RunStatus; label: string }> = [
  { label: 'Todos' },
  { value: 'running', label: 'Ejecutando' },
  { value: 'paused', label: 'Pausados' },
  { value: 'completed', label: 'Completados' },
  { value: 'failed', label: 'Fallidos' },
  { value: 'cancelled', label: 'Cancelados' },
];

export function RunList() {
  const router = useRouter();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [status, setStatus] = useState<RunStatus | undefined>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const busy = useRef(false);

  const load = useCallback(
    async (quiet = false) => {
      if (busy.current) return;
      busy.current = true;
      if (!quiet) setLoading(true);
      try {
        const page = await createStudioClient().listRuns({
          limit: 200,
          ...(status === undefined ? {} : { status }),
        });
        setRuns(page.runs);
        setError(undefined);
        setUpdatedAt(Date.now());
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [status],
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const counts = {
    running: runs.filter(({ status: value }) => value === 'running').length,
    paused: runs.filter(({ status: value }) => value === 'paused').length,
    failed: runs.filter(({ status: value }) => value === 'failed').length,
  };

  return (
    <main className="page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Diagnóstico local</p>
          <h1>Runs</h1>
          <p className="muted">
            Inspecciona ejecuciones, tools y approvals leyendo solo la API pública de Fevex.
          </p>
        </div>
        <div className="heading-actions">
          {updatedAt && (
            <span className="updated-at">
              Actualizado {formatRelative(new Date(updatedAt).toISOString())}
            </span>
          )}
          <button className="button" disabled={loading} onClick={() => void load()} type="button">
            {loading ? 'Actualizando…' : 'Actualizar'}
          </button>
        </div>
      </section>

      <section className="stats" aria-label="Resumen de runs">
        <div className="stat">
          <span className="stat-label">Visibles</span>
          <strong>{runs.length}</strong>
        </div>
        <div className="stat">
          <span className="stat-label">Ejecutando</span>
          <strong className={counts.running > 0 ? 'tone-info' : undefined}>{counts.running}</strong>
        </div>
        <div className="stat">
          <span className="stat-label">Pausados</span>
          <strong className={counts.paused > 0 ? 'tone-warning' : undefined}>
            {counts.paused}
          </strong>
        </div>
        <div className="stat">
          <span className="stat-label">Fallidos</span>
          <strong className={counts.failed > 0 ? 'tone-danger' : undefined}>{counts.failed}</strong>
        </div>
      </section>

      {error && (
        <div className="banner banner-danger" role="alert">
          <strong>No se pudo leer la API.</strong>
          <p>{error}</p>
          <p className="muted">
            Comprueba <code>{apiBaseUrl}</code> y arranca Nest con <code>bun run dev:nest</code>. Si
            la API exige token, configúralo en «Conexión».
          </p>
        </div>
      )}

      <section className="panel runs-panel">
        <div className="filters" role="tablist" aria-label="Filtrar por estado">
          {FILTERS.map((filter) => (
            <button
              aria-selected={status === filter.value}
              className="filter"
              key={filter.label}
              onClick={() => setStatus(filter.value)}
              role="tab"
              type="button"
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="run-table">
          <div className="run-table-head" aria-hidden="true">
            <span>Estado</span>
            <span>Run</span>
            <span>Modelo</span>
            <span>Creado</span>
            <span>Duración</span>
            <span>Resultado</span>
            <span />
          </div>

          {runs.map((run) => (
            <button
              className="run-row"
              key={run.id}
              onClick={() => router.push(`/runs/${encodeURIComponent(run.id)}`)}
              type="button"
            >
              <span>
                <StatusBadge status={run.status} />
              </span>
              <span className="run-name">
                <strong>{runName(run)}</strong>
                <small>
                  {runKindLabel(runKind(run))} · <code>{shortId(run.id)}</code>
                </small>
              </span>
              <span className="mono muted run-model" title={runModel(run) ?? ''}>
                {runModel(run) ?? '—'}
              </span>
              <span title={run.createdAt}>{formatRelative(run.createdAt)}</span>
              <span className="mono">{formatDuration(durationMs(run))}</span>
              <span className="run-result">{resultPreview(run)}</span>
              <span className="run-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          ))}

          {!loading && runs.length === 0 && !error && (
            <div className="empty">
              <p>No hay runs para este filtro.</p>
              <p className="muted">
                Crea uno desde el playground en <a href="http://localhost:3000">localhost:3000</a> y
                aparecerá aquí.
              </p>
            </div>
          )}

          {loading && runs.length === 0 && (
            <div className="empty">
              <span className="spinner" aria-hidden="true" />
              <p className="muted">Leyendo runs…</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function resultPreview(run: RunRecord): string {
  if (run.status === 'failed' && run.error) return previewValue(run.error);
  if (run.status === 'paused' && run.pause) return previewValue(pauseLabel(run.pause));
  if (run.output !== undefined) return previewValue(run.output);
  return '—';
}

function pauseLabel(pause: NonNullable<RunRecord['pause']>): string {
  if (pause.type === 'approval')
    return `Approval: ${pause.approval.toolLabel ?? pause.approval.toolName}`;
  if (pause.type === 'elicitation') return `Elicitation: ${pause.request.prompt}`;
  if (pause.type === 'tool_execution_unknown') return `Ejecución incierta: ${pause.toolName}`;
  if (pause.type === 'workflow_timer') return `Timer hasta ${pause.resumeAt}`;
  if (pause.type === 'workflow_event') return `Esperando evento ${pause.eventName}`;
  if (pause.type === 'workflow_child') return `Hijo pausado: ${pause.childRunId}`;
  return `Hijos pausados: ${pause.children.length}`;
}
