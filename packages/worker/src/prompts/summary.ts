import type { Job } from '@prisma/client';

export function buildSummaryPrompt(job: Job, research: unknown): string {
  return [
    'You are producing a newsletter. Input is raw research JSON.',
    '',
    'HARD RULES:',
    `- Max ${job.maxItems} items. Pick highest-signal; discard rest silently.`,
    '- Each item: headline ≤12 words, body exactly 1–2 sentences, ≤45 words.',
    '- Headline should describe the item itself — not who reacted to it. The body explains the event; the headline names it.',
    '- No preamble, no outro, no meta-commentary. No emoji.',
    '- Merge overlapping items.',
    '- If nothing interesting: empty items[] + one-line empty_reason. No padding.',
    '',
    "HONOR THE USER'S BRIEF:",
    '- Language: if the brief names a target language (e.g. "content should be in Turkish"), every string in the output MUST be in that language — subject, intro, headlines, bodies, categories.',
    '- Categories: if the brief lists section names (e.g. "categories: A, B, C"), assign each item a `category` field using one of those exact labels. Distribute items across the listed categories; omit a category if nothing fits rather than padding.',
    '- Tone / style: if the brief specifies voice, audience, or emphasis, apply it.',
    '- Any other explicit instruction in the brief overrides default rendering choices.',
    '',
    'Output: JSON only, no markdown fences, matching this schema:',
    '{',
    '  "subject": "string, ≤70 chars",',
    '  "intro": "string, ≤25 words, or \'\'",',
    '  "items": [ { "headline": "...", "body": "...", "source_url": "...", "category": "optional label, ≤60 chars" } ],',
    '  "empty_reason": "string (only if items empty)"',
    '}',
    '',
    '`category` is optional per item but should be present on every item when the brief requests sectioning.',
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
