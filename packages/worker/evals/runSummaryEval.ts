#!/usr/bin/env tsx
/**
 * Summary-stage eval runner.
 *
 * Loads every fixture in ./fixtures/, runs `attemptSummary` against the real
 * SDK (via the admin's mounted ~/.claude subscription), and checks the output
 * against the fixture's assertions. No DB, no web, no research stage.
 *
 * Run with: pnpm --filter @renews/worker eval:summary
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job } from '@prisma/client';
import { StageTwoSchema } from '@renews/shared';
import { attemptSummary } from '../src/pipeline/summarize.js';
import { buildRetryPrompt, buildSummaryPrompt } from '../src/prompts/summary.js';

type FixtureAssertions = {
  subjectMaxLen?: number;
  itemsMax?: number;
  language?: 'tr' | 'en' | 'de' | 'fr' | 'es';
  allowedCategories?: string[];
  requireCategoryOnEveryItem?: boolean;
  allowEmpty?: boolean;
  minBodyWords?: number;
  maxBodyWords?: number;
};

type Fixture = {
  name: string;
  job: Partial<Job> & {
    topic: string;
    basePrompt: string;
    maxItems: number;
    modelSummary: string;
  };
  research: unknown;
  assertions: FixtureAssertions;
};

type CheckResult = { ok: true } | { ok: false; reason: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function loadFixtures(): Promise<Fixture[]> {
  const files = await fs.readdir(FIXTURES_DIR);
  const out: Fixture[] = [];
  for (const f of files.sort()) {
    if (!f.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(FIXTURES_DIR, f), 'utf8');
    out.push(JSON.parse(raw) as Fixture);
  }
  return out;
}

function toJob(partial: Fixture['job']): Job {
  // Fill defaults for Job fields the pipeline doesn't touch at stage 2.
  // Cast to Job at the end — runtime only reads topic/basePrompt/maxItems/modelSummary.
  const now = new Date();
  return {
    id: '00000000-0000-0000-0000-000000000000',
    userId: '00000000-0000-0000-0000-000000000000',
    name: 'eval',
    enabled: true,
    schedule: '0 8 * * *',
    sources: [],
    recipientEmail: 'eval@example.com',
    outputFormat: 'markdown',
    modelResearch: 'claude-sonnet-4-6',
    monthlyBudget: 60,
    minIntervalMinutes: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  } as unknown as Job;
}

// --- assertion checks ---

const LATIN_STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'in', 'for'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'olarak'],
  de: ['der', 'die', 'das', 'und', 'ist', 'mit'],
  fr: ['le', 'la', 'les', 'et', 'de', 'pour'],
  es: ['el', 'la', 'los', 'y', 'de', 'para'],
};

function looksLike(text: string, lang: keyof typeof LATIN_STOPWORDS): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 5) return true; // too short to judge
  const hits = words.filter((w) => LATIN_STOPWORDS[lang].includes(w)).length;
  // Language "passes" if we see at least one stopword per ~40 words on average.
  return hits >= Math.max(1, Math.floor(words.length / 40));
}

function wordCount(s: string): number {
  return (s.match(/\p{L}+/gu) ?? []).length;
}

function checkAssertions(
  out: {
    subject: string;
    items: Array<{ body: string; category?: string }>;
    empty_reason?: string;
  },
  a: FixtureAssertions,
): CheckResult {
  const subjectMaxLen = a.subjectMaxLen ?? 70;
  if (out.subject.length > subjectMaxLen) {
    return { ok: false, reason: `subject too long: ${out.subject.length} > ${subjectMaxLen}` };
  }

  if (out.items.length === 0) {
    if (!a.allowEmpty) return { ok: false, reason: 'items is empty but allowEmpty=false' };
    if (!out.empty_reason) return { ok: false, reason: 'empty items without empty_reason' };
    return { ok: true };
  }

  if (a.itemsMax !== undefined && out.items.length > a.itemsMax) {
    return { ok: false, reason: `too many items: ${out.items.length} > ${a.itemsMax}` };
  }

  if (a.language) {
    const combined = [out.subject, ...out.items.flatMap((i) => [i.body])].join(' ');
    if (!looksLike(combined, a.language)) {
      return { ok: false, reason: `output does not look like language=${a.language}` };
    }
  }

  if (a.allowedCategories) {
    const allowed = new Set(a.allowedCategories);
    for (const [i, item] of out.items.entries()) {
      if (a.requireCategoryOnEveryItem && !item.category) {
        return { ok: false, reason: `item ${i} missing category` };
      }
      if (item.category && !allowed.has(item.category)) {
        return {
          ok: false,
          reason: `item ${i} has invalid category ${JSON.stringify(item.category)}`,
        };
      }
    }
  }

  const minWords = a.minBodyWords ?? 15;
  for (const [i, item] of out.items.entries()) {
    const wc = wordCount(item.body);
    if (wc < minWords) return { ok: false, reason: `item ${i} body too short (${wc} words)` };
    if (a.maxBodyWords && wc > a.maxBodyWords) {
      return { ok: false, reason: `item ${i} body too long (${wc} words)` };
    }
  }

  return { ok: true };
}

// --- main ---

type RowResult = {
  name: string;
  status: 'pass' | 'fail' | 'error';
  reason?: string;
  durationMs: number;
  retried: boolean;
};

async function runOne(fx: Fixture): Promise<RowResult> {
  const started = Date.now();
  const job = toJob(fx.job);
  let retried = false;
  try {
    let parsed: Awaited<ReturnType<typeof attemptSummary>>;
    try {
      parsed = await attemptSummary({ job, prompt: buildSummaryPrompt(job, fx.research) });
    } catch (e) {
      retried = true;
      const reason = e instanceof Error ? e.message : String(e);
      parsed = await attemptSummary({ job, prompt: buildRetryPrompt(reason) });
    }
    // Re-parse through StageTwoSchema to guarantee the shape we expect below.
    const shaped = StageTwoSchema.parse(parsed);
    const check = checkAssertions(shaped, fx.assertions);
    if (!check.ok) {
      return {
        name: fx.name,
        status: 'fail',
        reason: check.reason,
        durationMs: Date.now() - started,
        retried,
      };
    }
    return { name: fx.name, status: 'pass', durationMs: Date.now() - started, retried };
  } catch (e) {
    return {
      name: fx.name,
      status: 'error',
      reason: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - started,
      retried,
    };
  }
}

async function main() {
  const fixtures = await loadFixtures();
  if (fixtures.length === 0) {
    console.error(`No fixtures found in ${FIXTURES_DIR}`);
    process.exit(2);
  }
  console.log(`Running ${fixtures.length} summary evals...\n`);

  const results: RowResult[] = [];
  for (const fx of fixtures) {
    process.stdout.write(`  ${fx.name}... `);
    const r = await runOne(fx);
    results.push(r);
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'ERROR';
    const retryTag = r.retried ? ' (retried)' : '';
    console.log(`${tag}${retryTag}  ${(r.durationMs / 1000).toFixed(1)}s`);
    if (r.status !== 'pass') console.log(`      ${r.reason}`);
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
