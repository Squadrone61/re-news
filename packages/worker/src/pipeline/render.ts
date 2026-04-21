import type { Job } from '@prisma/client';
import type { StageTwo } from '@renews/shared';
import juice from 'juice';
import { marked } from 'marked';

const BASE_CSS = [
  'body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:16px;line-height:1.5;color:#222}',
  'h1,h2,h3{line-height:1.25;margin:1.2em 0 0.4em}',
  'h3{font-size:1.1em}',
  'hr{border:0;border-top:1px solid #ddd;margin:1.2em 0}',
  'a{color:#2563eb}',
  'p{margin:0.4em 0}',
].join('');

export function renderMarkdown(parsed: StageTwo): string {
  if (parsed.items.length === 0) {
    return parsed.empty_reason?.trim() || 'No items this run.';
  }
  const parts: string[] = [];
  if (parsed.intro && parsed.intro.trim().length > 0) {
    parts.push(parsed.intro.trim());
  }
  parts.push('---');
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

export function renderHtml(parsed: StageTwo): string {
  const md = renderMarkdown(parsed);
  const body = marked.parse(md, { async: false }) as string;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${body}</body></html>`;
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
