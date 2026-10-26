import { parseEvalReport, type EvalReport } from '@fevex/core/evals';

export async function requestResearchEvaluation(
  apiUrl: string, model: string, signal: AbortSignal,
  fetchImpl: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<EvalReport> {
  if (!model.trim()) throw new Error('Selecciona un modelo para evaluar.');
  const response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/research/evaluations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal,
  });
  if (!response.ok) {
    const messages: Record<number, string> = {
      401: 'Inicia sesión para ejecutar la evaluación.',
      403: 'No tienes permiso para ejecutar la evaluación.',
      400: 'El modelo seleccionado no está disponible. Recarga el catálogo.',
      409: 'Ya hay una evaluación en curso. Inténtalo cuando termine.',
      429: 'Se alcanzó el límite de solicitudes. Espera antes de volver a intentar.',
    };
    throw new Error(messages[response.status] ?? `Falló la evaluación (${response.status}). Puedes volver a intentarlo.`);
  }
  const report = parseEvalReport(await response.text());
  if (report.suiteName !== 'research' || report.agentName !== 'research' || report.cases.length !== 7
    || report.summary.caseCount !== 7 || !report.scorerIds.length
    || report.cases.some((result) => result.scores.length !== report.scorerIds.length)
    || ![report.summary.passedScoreCount, report.summary.failedScoreCount, report.summary.errorScoreCount, report.summary.latencyMs]
      .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    throw new Error('La API devolvió un informe de investigación incompleto.');
  }
  return report;
}
