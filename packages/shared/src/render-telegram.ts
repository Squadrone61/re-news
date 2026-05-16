import type { StageTwo } from './schemas.js';

/**
 * Render a StageTwo into Telegram HTML chunks (≤4000 chars each). Used by
 * the worker's delivery pipeline and the web resend route. Kept here in
 * @renews/shared so web doesn't need to import from the worker package
 * (which loads the Claude SDK native binary).
 *
 * Telegram allows only this HTML subset: <b>, <i>, <u>, <s>, <code>, <pre>,
 * <a href>. Anything else is rejected by the Bot API. Escape inner text;
 * chunk only at item boundaries so we never split a tag.
 */

const TG_MESSAGE_MAX = 4000;

function escapeTgText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeTgAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function renderTgItem(it: StageTwo['items'][number]): string {
  const headline = escapeTgText(it.headline);
  let body = escapeTgText(it.body);
  const href = escapeTgAttr(safeHref(it.source_url));
  // Single-item overflow: truncate body so the wrapped item fits one message.
  const overhead = headline.length + href.length + 64;
  if (body.length + overhead > TG_MESSAGE_MAX) {
    body = `${body.slice(0, TG_MESSAGE_MAX - overhead - 1)}…`;
  }
  return `<b>${headline}</b>\n${body}\n<a href="${href}">Source</a>`;
}

export function renderTelegramHtml(parsed: StageTwo): string[] {
  const subject = escapeTgText(parsed.subject || 'Newsletter');
  const blocks: string[] = [`<b>${subject}</b>`];

  if (parsed.items.length === 0) {
    blocks.push(escapeTgText(parsed.empty_reason?.trim() || 'No items this run.'));
  } else {
    if (parsed.intro && parsed.intro.trim().length > 0) {
      blocks.push(escapeTgText(parsed.intro.trim()));
    }
    const hasCategories = parsed.items.some((it) => (it.category ?? '').trim().length > 0);
    if (!hasCategories) {
      for (const it of parsed.items) blocks.push(renderTgItem(it));
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
        blocks.push(`<b>━ ${escapeTgText(label)} ━</b>`);
        for (const it of buckets.get(label)!) blocks.push(renderTgItem(it));
      }
    }
  }

  // Pack blocks into chunks at block boundaries.
  const chunks: string[] = [];
  let current = '';
  const sep = '\n\n';
  for (const b of blocks) {
    if (current.length === 0) {
      current = b;
      continue;
    }
    if (current.length + sep.length + b.length <= TG_MESSAGE_MAX) {
      current += sep + b;
    } else {
      chunks.push(current);
      current = b;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
