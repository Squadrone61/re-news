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

export function buildResearchPrompt(job: Job, outputPath: string): string {
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
    'If a fetch succeeds HTTP-wise but returns a paywall stub, login redirect, cookie consent wall, or a JS-shell page with no real content, record a fetch_errors entry (reason: "paywall" | "login_required" | "js_required" | "empty_shell") instead of dropping it silently or inventing content.',
    '',
    'Relevance: prefer primary sources over aggregators, recent items within the lookback window, and signal over repetition. The topic is the filter — if an item does not clearly relate to it, skip it rather than stretch.',
    '',
    'Balance: if one source threatens to fill most of the 25 slots, prefer breadth — cover more sources before deepening any single one. Readers lose trust when a "newsletter" is one outlet on repeat.',
    '',
    'Deduplicate aggressively. Treat as duplicates: identical canonical URLs (strip utm_*, ref, fbclid query params and trailing slashes before comparing), near-identical titles, and syndicated reposts of the same underlying story across sources. Keep the version from the most authoritative source.',
    '',
    'Skip items older than the lookback window.',
    '',
    `Write the output to this EXACT absolute path (do not use a relative path, do not use ~, do not write anywhere else): ${outputPath}`,
    `If you delegate via the Task tool, include this exact absolute path in the subagent's prompt — subagent working directories are not guaranteed to match yours, so relative paths like ./research.json may land in the wrong place.`,
    '',
    'The file must match this EXACT schema:',
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
    `Do not produce any other files. Your final action must be writing ${outputPath}.`,
  ].join('\n');
}
