import type { Job } from '@prisma/client';
import type { StageTwo } from '@renews/shared';
import juice from 'juice';

// Newspaper-style CSS. All selectors flat so `juice` can inline reliably
// (Gmail strips <style> blocks before rendering).
const NEWSPAPER_CSS = [
  "body{font-family:Georgia,'Times New Roman',Times,serif;max-width:680px;margin:0 auto;padding:24px 20px 40px;line-height:1.55;color:#1a1a1a;background:#fafaf7}",
  // Masthead
  '.mast{border-top:3px double #1a1a1a;border-bottom:1px solid #1a1a1a;padding:14px 0 10px;margin-bottom:22px;text-align:center}',
  ".mast .eyebrow{font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#555;margin:0 0 6px}",
  '.mast h1{font-family:Georgia,serif;font-size:30px;line-height:1.15;margin:0;font-weight:700;letter-spacing:-0.01em}',
  '.mast .date{font-style:italic;color:#555;font-size:13px;margin:8px 0 0}',
  // Intro / dek
  '.dek{font-size:16px;color:#333;font-style:italic;margin:0 0 24px;padding:0 6px;text-align:center;line-height:1.5}',
  // Category section header
  ".cat{font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#1a1a1a;margin:28px 0 14px;padding:0 0 4px;border-bottom:1px solid #1a1a1a}",
  // Article
  '.item{margin:0 0 22px;padding:0 0 20px;border-bottom:1px solid #d8d6cc}',
  '.item:last-child{border-bottom:0}',
  '.item h2{font-family:Georgia,serif;font-size:20px;line-height:1.25;margin:0 0 4px;font-weight:700}',
  '.item h2 a{color:#1a1a1a;text-decoration:none}',
  '.item h2 a:hover{text-decoration:underline}',
  ".item .byline{font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;color:#6a6a6a;letter-spacing:0.05em;margin:0 0 8px;text-transform:uppercase}",
  '.item p.body{margin:8px 0 0;font-size:15px;color:#1a1a1a;line-height:1.6}',
  // Footer
  '.foot{margin-top:32px;padding-top:14px;border-top:1px solid #c8c6bd;text-align:center;font-size:11px;color:#777;letter-spacing:0.08em;text-transform:uppercase;font-family:-apple-system,Helvetica,Arial,sans-serif}',
  // Empty state
  '.empty{text-align:center;color:#555;font-style:italic;padding:40px 20px}',
].join('');

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch {
    // fall through
  }
  return '#';
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function renderMarkdown(parsed: StageTwo): string {
  if (parsed.items.length === 0) {
    return parsed.empty_reason?.trim() || 'No items this run.';
  }
  const parts: string[] = [];
  if (parsed.intro && parsed.intro.trim().length > 0) {
    parts.push(parsed.intro.trim());
  }
  parts.push('---');

  const hasCategories = parsed.items.some((it) => (it.category ?? '').trim().length > 0);

  if (!hasCategories) {
    for (const it of parsed.items) {
      parts.push(`### ${it.headline}`);
      parts.push('');
      parts.push(it.body);
      parts.push('');
      parts.push(`[Source](${it.source_url})`);
      parts.push('');
    }
    return parts.join('\n');
  }

  // Group items by category in first-appearance order. Items without a
  // category are grouped under "Other" so the model can still mix styles.
  const order: string[] = [];
  const buckets = new Map<string, StageTwo['items']>();
  for (const it of parsed.items) {
    const label = (it.category ?? '').trim() || 'Other';
    if (!buckets.has(label)) {
      buckets.set(label, []);
      order.push(label);
    }
    buckets.get(label)!.push(it);
  }

  for (const label of order) {
    parts.push(`## ${label}`);
    parts.push('');
    for (const it of buckets.get(label)!) {
      parts.push(`### ${it.headline}`);
      parts.push('');
      parts.push(it.body);
      parts.push('');
      parts.push(`[Source](${it.source_url})`);
      parts.push('');
    }
  }
  return parts.join('\n');
}

export function renderHtml(parsed: StageTwo, now: Date = new Date()): string {
  const parts: string[] = [];

  const subject = escapeHtml(parsed.subject || 'Newsletter');
  parts.push('<div class="mast">');
  parts.push('<p class="eyebrow">re-news</p>');
  parts.push(`<h1>${subject}</h1>`);
  parts.push(`<p class="date">${escapeHtml(formatDate(now))}</p>`);
  parts.push('</div>');

  if (parsed.items.length === 0) {
    const reason = parsed.empty_reason?.trim() || 'No items this run.';
    parts.push(`<div class="empty">${escapeHtml(reason)}</div>`);
    parts.push(footer(now));
    return wrapHtml(subject, parts.join(''));
  }

  if (parsed.intro && parsed.intro.trim().length > 0) {
    parts.push(`<p class="dek">${escapeHtml(parsed.intro.trim())}</p>`);
  }

  const hasCategories = parsed.items.some((it) => (it.category ?? '').trim().length > 0);

  if (!hasCategories) {
    for (const it of parsed.items) parts.push(renderItem(it));
  } else {
    const order: string[] = [];
    const buckets = new Map<string, StageTwo['items']>();
    for (const it of parsed.items) {
      const label = (it.category ?? '').trim() || 'Other';
      if (!buckets.has(label)) {
        buckets.set(label, []);
        order.push(label);
      }
      buckets.get(label)!.push(it);
    }
    for (const label of order) {
      parts.push(`<h3 class="cat">${escapeHtml(label)}</h3>`);
      for (const it of buckets.get(label)!) parts.push(renderItem(it));
    }
  }

  parts.push(footer(now));
  return wrapHtml(subject, parts.join(''));
}

function renderItem(it: StageTwo['items'][number]): string {
  const href = safeHref(it.source_url);
  const domain = extractDomain(it.source_url);
  const headline = escapeHtml(it.headline);
  const body = escapeHtml(it.body);
  const byline = domain ? `<p class="byline">${escapeHtml(domain)}</p>` : '';
  return [
    '<article class="item">',
    `<h2><a href="${href}">${headline}</a></h2>`,
    byline,
    `<p class="body">${body}</p>`,
    '</article>',
  ].join('');
}

function footer(now: Date): string {
  return `<div class="foot">re-news · ${escapeHtml(formatDate(now))}</div>`;
}

function wrapHtml(subject: string, body: string): string {
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${subject}</title>`,
    `<style>${NEWSPAPER_CSS}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('');
  return juice(html);
}

export function renderJson(parsed: StageTwo): string {
  return JSON.stringify(parsed, null, 2);
}

export function runRender(job: Job, parsed: StageTwo): string {
  switch (job.outputFormat) {
    case 'html':
      return renderHtml(parsed);
    case 'json':
      return renderJson(parsed);
    default:
      return renderMarkdown(parsed);
  }
}
