import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Job } from '@prisma/client';
import { prisma, streamLogToDb } from '@renews/shared';
import { buildResearchPrompt } from '../prompts/research.js';
import { RateLimitError, detectRateLimit } from './errors.js';
import { type UsageTotals, addUsage, emptyUsage, extractUsage } from './usage.js';

const RUNS_ROOT = process.env.RUNS_DIR ?? '/app/data/runs';
const MAX_ITEMS = 25;
const MAX_CONTENT_CHARS = 800;

export type ResearchJson = {
  fetched_at?: string;
  items?: Array<Record<string, unknown>>;
  fetch_errors?: Array<Record<string, unknown>>;
};

export async function runResearch(
  runId: string,
  job: Job,
  usage: UsageTotals = emptyUsage(),
): Promise<ResearchJson> {
  if (process.env.SIM_RATE_LIMIT === '1') {
    throw new RateLimitError('rate_limit: simulated', new Date(Date.now() + 3600 * 1000));
  }

  const cwd = path.join(RUNS_ROOT, runId);
  await fs.mkdir(cwd, { recursive: true });

  try {
    for await (const msg of query({
      prompt: buildResearchPrompt(job),
      options: {
        allowedTools: ['WebFetch', 'WebSearch', 'Bash', 'Read', 'Write'],
        permissionMode: 'acceptEdits',
        cwd,
        model: job.modelResearch,
        maxTurns: 40,
      },
    })) {
      addUsage(usage, extractUsage(msg));
      await streamLogToDb(runId, 'research', msg);
    }
  } catch (e) {
    const rl = detectRateLimit(e);
    if (rl) throw rl;
    throw e;
  }

  const researchPath = path.join(cwd, 'research.json');
  let raw: string;
  try {
    raw = await fs.readFile(researchPath, 'utf8');
  } catch {
    throw new Error('research.json missing');
  }

  let parsed: ResearchJson;
  try {
    parsed = JSON.parse(raw) as ResearchJson;
  } catch {
    throw new Error('research.json invalid JSON');
  }

  const truncated = await truncateResearch(runId, parsed);

  await prisma.run.update({
    where: { id: runId },
    data: { researchRaw: truncated as object },
  });

  const nItems = truncated.items?.length ?? 0;
  const nErrors = truncated.fetch_errors?.length ?? 0;
  await streamLogToDb(runId, 'sys', `research_done: ${nItems} items, ${nErrors} fetch_errors`);

  return truncated;
}

async function truncateResearch(runId: string, parsed: ResearchJson): Promise<ResearchJson> {
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  if (rawItems.length > MAX_ITEMS) {
    await streamLogToDb(
      runId,
      'sys',
      `truncated items to ${MAX_ITEMS} (prompt cap violated: ${rawItems.length})`,
      'warn',
    );
  }
  const items = rawItems.slice(0, MAX_ITEMS);
  const capped: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const content = item.content;
    if (typeof content === 'string' && content.length > MAX_CONTENT_CHARS) {
      const url = typeof item.url === 'string' ? item.url : 'item';
      await streamLogToDb(
        runId,
        'sys',
        `truncated content for ${url} to ${MAX_CONTENT_CHARS} chars`,
        'warn',
      );
      capped.push({ ...item, content: content.slice(0, MAX_CONTENT_CHARS) });
    } else {
      capped.push(item);
    }
  }
  const errors = Array.isArray(parsed.fetch_errors) ? parsed.fetch_errors : [];
  return {
    fetched_at:
      typeof parsed.fetched_at === 'string' ? parsed.fetched_at : new Date().toISOString(),
    items: capped,
    fetch_errors: errors,
  };
}
