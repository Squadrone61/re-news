import type { Job } from '@prisma/client';

export function buildSummaryPrompt(job: Job, research: unknown): string {
  return [
    'You are producing a newsletter. Input is raw research JSON.',
    '',
    'HARD RULES:',
    `- Max ${job.maxItems} items. Pick highest-signal; discard rest silently.`,
    '- Each item: headline ≤12 words, body exactly 1–2 sentences, ≤45 words.',
    '- No preamble, no outro, no meta-commentary. No emoji.',
    '- Merge overlapping items.',
    '- If nothing interesting: empty items[] + one-line empty_reason. No padding.',
    '',
    'Output: JSON only, no markdown fences, matching this schema:',
    '{',
    '  "subject": "string, ≤70 chars",',
    '  "intro": "string, ≤25 words, or \'\'",',
    '  "items": [ { "headline": "...", "body": "...", "source_url": "..." } ],',
    '  "empty_reason": "string (only if items empty)"',
    '}',
    '',
    "USER'S BRIEF:",
    job.basePrompt,
    '',
    'RESEARCH JSON:',
    JSON.stringify(research),
  ].join('\n');
}

export function buildRetryPrompt(): string {
  return 'Your previous response violated a length rule or JSON shape. Re-emit strictly tighter JSON only — same schema, same max_items, no preamble.';
}
