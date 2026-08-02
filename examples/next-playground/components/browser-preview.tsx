'use client';

import { useEffect, useState } from 'react';

type PreviewState = 'connecting' | 'live' | 'stopped' | 'error';

interface PreviewFrame {
  mimeType: string;
  base64: string;
  capturedAt: string;
}

/**
 * Read-only live view of a run's internal browser session.
 *
 * Consumes the authenticated SSE stream from the Nest API
 * (`GET /v1/runs/:runId/preview`). EventSource cannot set headers, so the actor
 * defaults server-side to the demo owner; a multi-actor app would pass identity
 * via cookie or query param.
 */
export function BrowserPreview({ apiUrl, runId }: { apiUrl: string; runId: string }) {
  const [state, setState] = useState<PreviewState>('connecting');
  const [frame, setFrame] = useState<PreviewFrame>();

  useEffect(() => {
    setState('connecting');
    const source = new EventSource(`${apiUrl}/v1/runs/${runId}/preview`);

    source.addEventListener('frame', (event) => {
      try {
        setFrame(JSON.parse((event as MessageEvent).data) as PreviewFrame);
        setState('live');
      } catch {
        setState('error');
      }
    });
    source.addEventListener('end', () => {
      setState('stopped');
      source.close();
    });
    source.addEventListener('error', () => {
      // SSE fires 'error' both on server error events and on disconnect.
      setState((prev) => (prev === 'stopped' ? prev : 'error'));
    });

    return () => source.close();
  }, [apiUrl, runId]);

  const src = frame ? `data:${frame.mimeType};base64,${frame.base64}` : undefined;

  return (
    <div style={wrap}>
      <div style={headerRow}>
        <strong style={{ fontSize: 12 }}>Navegador interno</strong>
        <span style={{ ...badge, ...badgeColor(state) }}>{stateLabel(state)}</span>
      </div>
      <div style={stage}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="Vista del navegador del run" style={img} />
        ) : (
          <span style={{ color: '#94a3b8', fontSize: 12 }}>Esperando el primer frame…</span>
        )}
      </div>
      {frame && (
        <small style={{ color: '#94a3b8', fontSize: 11 }}>
          Último frame: {new Date(frame.capturedAt).toLocaleTimeString()}
        </small>
      )}
    </div>
  );
}

function stateLabel(state: PreviewState): string {
  return { connecting: 'Conectando', live: 'En vivo', stopped: 'Detenido', error: 'Error' }[state];
}

function badgeColor(state: PreviewState): { background: string; color: string } {
  switch (state) {
    case 'live':
      return { background: 'rgba(34,197,94,0.15)', color: '#22c55e' };
    case 'error':
      return { background: 'rgba(239,68,68,0.15)', color: '#ef4444' };
    case 'stopped':
      return { background: 'rgba(148,163,184,0.15)', color: '#94a3b8' };
    default:
      return { background: 'rgba(125,211,252,0.15)', color: '#7dd3fc' };
  }
}

const wrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 12,
  borderTop: '1px solid rgba(148,163,184,0.2)',
};
const headerRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};
const badge: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: 999,
};
const stage: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 160,
  background: '#0b1020',
  borderRadius: 8,
  overflow: 'hidden',
};
const img: React.CSSProperties = { width: '100%', height: 'auto', display: 'block' };
