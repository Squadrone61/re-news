import type { Job } from '@prisma/client';

export function buildSummaryPrompt(job: Job, research: unknown): string {
  return [
    'You are producing a newsletter. Input is raw research JSON.',
    '',
    'HARD RULES (these are correctness; violating them fails the run):',
    `- At most ${job.maxItems} items. Pick highest-signal; discard rest silently.`,
    '- Subject ≤ 70 characters.',
    '- Output JSON only, no markdown fences, no preamble, no outro, no meta-commentary.',
    '- Every item must have a valid source_url copied from the research.',
    '- If nothing interesting was found: emit `items: []` plus a one-line `empty_reason` explaining why. Do not pad with filler.',
    "- The user's brief (below) takes precedence over any default you would otherwise assume.",
    '',
    "HONOR THE USER'S BRIEF (the user controls length, tone, structure via their brief):",
    '- Language: if the brief names a target language (e.g. "content should be in Turkish"), every string in the output MUST be in that language — subject, intro, headlines, bodies, categories.',
    '- Length: if the brief specifies a per-item length (word count, sentence count, "brief"/"detailed"), honor it. Absent a directive, default to 2-4 sentence bodies (roughly 30-60 words each) with real substance — do not truncate for brevity.',
    '- Categories: if the brief lists section names (e.g. "categories: A, B, C"), every item\'s `category` must be one of those exact labels — do not invent new categories. Omit any listed category that has no matching items in the research rather than padding. Do not force every listed category to appear.',
    "- Headlines: name the event itself. Don't write 'X reacted to Y' when the story is Y — the body explains the event, the headline names it.",
    '- Tone / style / audience / ordering: whatever the brief says.',
    "- Merge overlapping items before counting against the max: combine them into one item whose body reflects the full picture, use the most authoritative source_url, and mention the corroborating angle from the other sources where useful. Do not just pick one and drop the others' context.",
    '',
    'OUTPUT SCHEMA (JSON, no fences):',
    '{',
    '  "subject": "string, ≤70 chars",',
    '  "intro": "string or \'\'",',
    '  "items": [ { "headline": "...", "body": "...", "source_url": "...", "category": "optional label, ≤60 chars" } ],',
    '  "empty_reason": "string (only when items is empty)"',
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

export function buildRetryPrompt(reason: string): string {
  return [
    'Your previous response failed validation with this error:',
    reason,
    '',
    'Re-emit the same newsletter strictly fixing that error. JSON only — same schema, same max_items, no preamble, no markdown fences. If the error was a length rule, tighten the offending field; if it was a shape error, fix the shape. Do not change anything unrelated.',
  ].join('\n');
}
