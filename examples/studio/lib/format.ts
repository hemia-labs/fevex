import type { RunRecord } from '@fevex/core';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export function runKind(run: RunRecord): 'agent' | 'workflow' | 'team' {
  return run.kind ?? 'agent';
}

export function runName(run: RunRecord): string {
  if (run.kind === 'workflow') return run.workflowName;
  if (run.kind === 'team') return run.teamName;
  return run.agentName;
}

export function runModel(run: RunRecord): string | undefined {
  return run.kind === 'agent' ? run.modelName : undefined;
}

export function runStatusTone(status: RunRecord['status']): Tone {
  if (status === 'running') return 'info';
  if (status === 'paused') return 'warning';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

export function statusLabel(status: RunRecord['status']): string {
  return {
    running: 'Ejecutando',
    paused: 'Pausado',
    completed: 'Completado',
    failed: 'Falló',
    cancelled: 'Cancelado',
  }[status];
}

export function durationMs(run: RunRecord, now = Date.now()): number {
  const start = Date.parse(run.createdAt);
  const end = run.status === 'running' ? now : Date.parse(run.updatedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const dateTime = new Intl.DateTimeFormat('es', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTime.format(date);
}

export function formatRelative(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const delta = Math.max(0, now - timestamp);
  if (delta < 5_000) return 'ahora';
  if (delta < 60_000) return `hace ${Math.floor(delta / 1_000)} s`;
  if (delta < 3_600_000) return `hace ${Math.floor(delta / 60_000)} min`;
  if (delta < 86_400_000) return `hace ${Math.floor(delta / 3_600_000)} h`;
  return `hace ${Math.floor(delta / 86_400_000)} d`;
}

export function shortId(value: string, length = 8): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function formatNumber(value: number | undefined): string {
  return value === undefined ? '—' : new Intl.NumberFormat('es').format(value);
}

export function formatJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function previewValue(value: unknown, max = 160): string {
  const text = typeof value === 'string' ? value : formatJson(value);
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
