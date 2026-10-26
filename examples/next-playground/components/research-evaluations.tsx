'use client';

import { useEffect, useRef, useState } from 'react';
import type { EvalReport } from '@fevex/core/evals';
import { serializeEvalReport } from '@fevex/core/evals';
import { requestResearchEvaluation } from '../lib/research-evaluations';
import { Button } from './ui/button';

export function ResearchEvaluations({ apiUrl, model, disabled }: { apiUrl: string; model: string; disabled: boolean }) {
  const [report, setReport] = useState<EvalReport>();
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    controllerRef.current?.abort();
    setReport(undefined); setError(''); setRunning(false);
    return () => controllerRef.current?.abort();
  }, [model]);

  async function evaluate() {
    if (running || disabled || !model) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true); setError(''); setReport(undefined);
    try {
      const next = await requestResearchEvaluation(apiUrl, model,
        AbortSignal.any([controller.signal, AbortSignal.timeout(130_000)]));
      if (!controller.signal.aborted) setReport(next);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error && cause.name === 'TimeoutError'
        ? 'La evaluación excedió el tiempo disponible. Puedes volver a intentarlo.'
        : cause instanceof Error ? cause.message : 'No se pudo evaluar. Puedes volver a intentarlo.');
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  return (
    <section aria-label="Evaluaciones de investigación" className="mb-5 rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">7 casos con datos de prueba. Usa la API del modelo seleccionado.</p>
        <Button disabled={disabled || running || !model} onClick={() => void evaluate()} size="sm" type="button" variant="outline">
          {running ? 'Evaluando…' : 'Evaluar modelo'}
        </Button>
      </div>
      <div aria-live="polite" className="mt-2">
        {running && <p role="status">Ejecutando casos de investigación…</p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {report && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p>{report.summary.passedScoreCount} checks correctos · {report.summary.failedScoreCount + report.summary.errorScoreCount} fallidos · {report.summary.latencyMs.toFixed(0)} ms</p>
            <a className="underline underline-offset-4" download="research-report.json"
              href={`data:application/json;charset=utf-8,${encodeURIComponent(serializeEvalReport(report))}`}>
              Descargar JSON
            </a>
          </div>
        )}
      </div>
      {report && (
        <details className="mt-2">
          <summary className="cursor-pointer">Resultados por caso ({report.targetVersion})</summary>
          <ul className="mt-2 space-y-2">
            {report.cases.map((result) => (
              <li className="break-words" key={result.caseId}>
                <strong>{result.caseId}</strong>{' · '}
                {result.scores.every((score) => score.status === 'passed') ? 'Correcto' : 'Revisar'}
                {result.caseId === 'api-unavailable' && ' · fallo de API esperado'}
                <ul className="pl-3 text-muted-foreground">
                  {result.scores.map((score) => <li key={score.scorerId}>{score.scorerId}: {score.status}</li>)}
                  {result.error && <li>{result.error}</li>}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
