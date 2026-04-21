import type { Job } from '@prisma/client';
import { lookbackFromSchedule } from '@renews/shared';

type SourceEntry = { url: string; hint?: string; needs_browser?: boolean };

function parseSources(raw: unknown): SourceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) => {
    if (!s || typeof s !== 'object') return [];
    const o = s as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url : null;
    if (!url) return [];
    const entry: SourceEntry = { url };
    if (typeof o.hint === 'string') entry.hint = o.hint;
    if (o.needs_browser === true || o.needsBrowser === true) entry.needs_browser = true;
    return [entry];
  });
}

function renderSources(sources: SourceEntry[]): string {
  if (sources.length === 0) return '- (no sources configured)';
  return sources
    .map((s) => {
      const bits = [`- ${s.url}`];
      if (s.hint) bits.push(`(hint: ${s.hint})`);
      if (s.needs_browser) bits.push('[skip: Playwright deferred — record as fetch_error]');
      return bits.join('  ');
    })
    .join('\n');
}

export function buildResearchPrompt(job: Job): string {
  const sources = parseSources(job.sources);
  const lookback = lookbackFromSchedule(job.schedule);
  return [
    'You are a research agent. Gather recent, relevant content from the sources below related to the topic.',
    '',
    `TOPIC: ${job.topic}`,
    `LOOKBACK WINDOW: ${lookback}`,
    'MAX ITEMS: 25',
    'MAX CONTENT PER ITEM: 800 characters',
    '',
    'SOURCES:',
    renderSources(sources),
    '',
    'For each source, pick the best fetch method: WebFetch for static HTML; Bash + curl for RSS feeds; skip with a fetch_errors entry if the source is marked [skip: Playwright deferred] (reason: "needs_browser, Playwright deferred").',
    '',
    'Deduplicate by URL and near-identical titles. Skip items older than the lookback window.',
    '',
    'Write ./research.json (in your working directory) with this EXACT schema:',
    '{',
    '  "fetched_at": "<ISO timestamp>",',
    '  "items": [',
    '    { "source": "<source url>", "title": "<title>", "url": "<item url>", "published_at": "<ISO or null>", "content": "<≤800 chars>" }',
    '  ],',
    '  "fetch_errors": [',
    '    { "source": "<source url>", "reason": "<short reason>" }',
    '  ]',
    '}',
    '',
    'Do not invent items. Empty items[] is valid if nothing relevant was found.',
    'Do not produce any other files. Your final action must be writing research.json.',
  ].join('\n');
}
