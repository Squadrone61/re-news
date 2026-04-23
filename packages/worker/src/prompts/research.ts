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
      if (s.needs_browser) bits.push('[use browser]');
      return bits.join('  ');
    })
    .join('\n');
}

export function buildResearchPrompt(job: Job, outputPath: string): string {
  const sources = parseSources(job.sources);
  const hasBrowserSources = sources.some((s) => s.needs_browser);
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
    hasBrowserSources
      ? 'For each source, pick the best fetch method: WebFetch for static HTML; Bash + curl for RSS feeds; for sources marked [use browser], call mcp__playwright__browser_navigate, then mcp__playwright__browser_snapshot to read the rendered content. Dismiss consent banners with mcp__playwright__browser_click when they block content, and use mcp__playwright__browser_wait_for if the page is lazy-loaded. If the browser fails (navigation timeout, crash, blank page), record a fetch_errors entry (reason: "browser_failed" | "browser_timeout") and move on.'
      : 'For each source, pick the best fetch method: WebFetch for static HTML; Bash + curl for RSS feeds.',
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
    'Tool note: the Read tool caps file content at ~25k tokens and throws on larger files. For any file you fetch with Bash/curl that may be large (RSS, HTML dumps), do not Read it raw — pipe through grep/head/sed in Bash, or use the Grep tool, or Read with offset/limit.',
    '',
    'Do not invent items. Empty items[] is valid if nothing relevant was found.',
    `Do not produce any other files. Your final action must be writing ${outputPath}.`,
  ].join('\n');
}
