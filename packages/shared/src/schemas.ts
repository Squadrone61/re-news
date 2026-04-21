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

export const JobUpdate = JobInput.partial();
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
    }),
  ),
  empty_reason: z.string().optional(),
});
export type StageTwo = z.infer<typeof StageTwoSchema>;

export function validateLengths(p: StageTwo, maxItems: number): void {
  if (p.items.length > maxItems) {
    throw new Error(`too many items (${p.items.length} > ${maxItems})`);
  }
  for (const it of p.items) {
    const words = it.body.trim().split(/\s+/).filter(Boolean).length;
    if (words > 50) throw new Error(`item body too long (${words} words)`);
  }
  if (p.subject.length > 70) throw new Error('subject too long');
}

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
