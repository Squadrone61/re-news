import { z } from 'zod';

export const SourceInput = z.object({
  url: z.string().url(),
  hint: z.string().max(500).optional(),
  needsBrowser: z.boolean().optional(),
});
export type SourceInput = z.infer<typeof SourceInput>;

export const OutputFormat = z.enum(['markdown', 'html', 'json']);
export type OutputFormat = z.infer<typeof OutputFormat>;

export const JobInput = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  schedule: z.string().min(1).max(100),
  sources: z.array(SourceInput).default([]),
  topic: z.string().min(1).max(500),
  basePrompt: z.string().min(1).max(10_000),
  recipientEmail: z.string().email(),
  outputFormat: OutputFormat.default('markdown'),
  maxItems: z.number().int().min(1).max(25).default(6),
  modelResearch: z.string().default('claude-sonnet-4-6'),
  modelSummary: z.string().default('claude-haiku-4-5'),
  monthlyBudget: z.number().int().min(1).max(100_000).default(60),
  minIntervalMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
});
export type JobInput = z.infer<typeof JobInput>;

// Partial update: every field optional, no defaults — missing key = "don't touch".
// Do NOT reuse `JobInput.partial()`: zod's `.default([])` etc. still fire on missing
// keys and would silently wipe server-side data. Spell each field out explicitly.
export const JobUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  schedule: z.string().min(1).max(100).optional(),
  sources: z.array(SourceInput).optional(),
  topic: z.string().min(1).max(500).optional(),
  basePrompt: z.string().min(1).max(10_000).optional(),
  recipientEmail: z.string().email().optional(),
  outputFormat: OutputFormat.optional(),
  maxItems: z.number().int().min(1).max(25).optional(),
  modelResearch: z.string().optional(),
  modelSummary: z.string().optional(),
  monthlyBudget: z.number().int().min(1).max(100_000).optional(),
  minIntervalMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
});
export type JobUpdate = z.infer<typeof JobUpdate>;

export const SetupInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type SetupInput = z.infer<typeof SetupInput>;

export const LoginInput = SetupInput;
export type LoginInput = z.infer<typeof LoginInput>;

export const UserCreateInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  isAdmin: z.boolean().default(false),
});
export type UserCreateInput = z.infer<typeof UserCreateInput>;

export const StageTwoSchema = z.object({
  subject: z.string().max(70),
  intro: z.string().max(200),
  items: z.array(
    z.object({
      headline: z.string(),
      body: z.string(),
      source_url: z.string().url(),
      // Optional section label the render layer groups by when any item has one.
      // The user's base prompt can drive category choice (e.g. "Politics", "Sports").
      category: z.string().max(60).optional(),
    }),
  ),
  empty_reason: z.string().optional(),
});
export type StageTwo = z.infer<typeof StageTwoSchema>;

export function validateLengths(p: StageTwo, maxItems: number): void {
  if (p.items.length > maxItems) {
    throw new Error(`too many items (${p.items.length} > ${maxItems})`);
  }
  if (p.subject.length > 70) throw new Error('subject too long');
  // Body length is intentionally NOT enforced here — the user's base prompt
  // drives per-item length. The Stage 2 prompt still asks the model to keep
  // newsletters reasonable, but length is a stylistic choice, not a correctness
  // gate, so we don't burn retries on a 60-word body.
}

export const SourceBriefSchema = z.object({
  source_url: z.string().url(),
  items: z
    .array(
      z.object({
        title: z.string().max(300),
        url: z.string().url(),
        summary: z.string().max(800),
        published_at: z.string().optional(),
      }),
    )
    .max(15),
  fetch_errors: z
    .array(
      z.object({
        code: z.string(),
        detail: z.string().max(400),
      }),
    )
    .default([]),
});
export type SourceBrief = z.infer<typeof SourceBriefSchema>;

export const SettingsInput = z
  .object({
    gmailUser: z.string().email().nullable().optional(),
    gmailAppPassword: z.string().optional(),
    senderName: z.string().min(1).max(200).nullable().optional(),
    defaultModelResearch: z.string().min(1).max(100).optional(),
    defaultModelSummary: z.string().min(1).max(100).optional(),
    workerConcurrency: z.number().int().min(1).max(10).optional(),
  })
  .strict();
export type SettingsInput = z.infer<typeof SettingsInput>;

export const UserUpdateInput = z
  .object({
    email: z.string().email().optional(),
    password: z.string().min(8).max(200).optional(),
    isAdmin: z.boolean().optional(),
  })
  .refine((v) => v.email !== undefined || v.password !== undefined || v.isAdmin !== undefined, {
    message: 'no fields to update',
  });
export type UserUpdateInput = z.infer<typeof UserUpdateInput>;
