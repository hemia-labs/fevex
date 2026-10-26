export type ResearchSource = { title: string; url: string; quote: string };
export type ResearchAnswer = {
  answer: string;
  status: 'answered' | 'insufficient';
  sources: ResearchSource[];
  account: { id: number; status: 'active' | 'paused'; plan: 'free' | 'pro' } | null;
};

export function safeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

/** Also used at the browser boundary; no runtime or provider code is bundled. */
export function readResearchAnswer(value: unknown): ResearchAnswer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const result = value as Record<string, unknown>;
  if (typeof result.answer !== 'string' || !result.answer.trim()
    || !['answered', 'insufficient'].includes(String(result.status))
    || !Array.isArray(result.sources) || result.sources.length > 8) return;
  if (!result.sources.every((source) => source && typeof source === 'object'
    && typeof source.title === 'string' && source.title.trim().length > 0
    && typeof source.quote === 'string' && source.quote.trim().length > 0 && source.quote.length <= 500
    && typeof source.url === 'string' && safeSourceUrl(source.url))) return;
  const account = result.account;
  if (account !== null && (!account || typeof account !== 'object'
    || !Number.isSafeInteger((account as Record<string, unknown>).id)
    || Number((account as Record<string, unknown>).id) < 1
    || !['active', 'paused'].includes(String((account as Record<string, unknown>).status))
    || !['free', 'pro'].includes(String((account as Record<string, unknown>).plan)))) return;
  return value as ResearchAnswer;
}
