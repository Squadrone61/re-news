import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Job } from '@prisma/client';
import { prisma, streamLogToDb } from '@renews/shared';
import { buildResearchPrompt } from '../prompts/research.js';
import { CancelledError, RateLimitError, detectRateLimit } from './errors.js';
import { type UsageTotals, addUsage, emptyUsage, extractUsage } from './usage.js';

const RUNS_ROOT = process.env.RUNS_DIR ?? '/app/data/runs';
const MAX_ITEMS = 25;
const MAX_CONTENT_CHARS = 800;

const BROWSER_TOOLS = [
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_wait_for',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_press_key',
  'mcp__playwright__browser_handle_dialog',
  'mcp__playwright__browser_hover',
];

let cachedPlaywrightMcpCli: string | null = null;
function resolvePlaywrightMcpCli(): string {
  if (cachedPlaywrightMcpCli) return cachedPlaywrightMcpCli;
  // @playwright/mcp's exports map does not expose cli.js directly, but
  // package.json is always listed. Resolve that and join the CLI file name.
  const req = createRequire(import.meta.url);
  const pkgJsonPath = req.resolve('@playwright/mcp/package.json');
  cachedPlaywrightMcpCli = path.join(path.dirname(pkgJsonPath), 'cli.js');
  return cachedPlaywrightMcpCli;
}

function jobHasBrowserSources(job: Job): boolean {
  const raw = job.sources;
  if (!Array.isArray(raw)) return false;
  return raw.some((s) => {
    if (!s || typeof s !== 'object') return false;
    const o = s as Record<string, unknown>;
    return o.needs_browser === true || o.needsBrowser === true;
  });
}

export type ResearchJson = {
  fetched_at?: string;
  items?: Array<Record<string, unknown>>;
  fetch_errors?: Array<Record<string, unknown>>;
};

async function researchFileUsable(p: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

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
  const researchPath = path.join(cwd, 'research.json');

  const useBrowser = jobHasBrowserSources(job);
  const allowedTools = ['WebFetch', 'WebSearch', 'Bash', 'Read', 'Write', 'Task'];
  const mcpServers: Record<string, { command: string; args?: string[] }> = {};
  if (useBrowser) {
    allowedTools.push(...BROWSER_TOOLS);
    mcpServers.playwright = {
      command: process.execPath,
      args: [
        resolvePlaywrightMcpCli(),
        '--browser=chromium',
        '--headless',
        '--isolated',
        '--output-dir',
        path.join(cwd, 'browser'),
      ],
    };
    await streamLogToDb(runId, 'sys', 'browser: Playwright MCP enabled for this run');
  }

  const controller = new AbortController();
  const cancelWatch = setInterval(() => {
    prisma.run
      .findUnique({ where: { id: runId }, select: { cancelRequested: true } })
      .then((r) => {
        if (r?.cancelRequested) controller.abort();
      })
      .catch(() => {
        /* transient DB read failure — next tick will retry */
      });
  }, 1000);

  try {
    for await (const msg of query({
      prompt: buildResearchPrompt(job, researchPath),
      options: {
        allowedTools,
        permissionMode: 'acceptEdits',
        cwd,
        model: job.modelResearch,
        maxTurns: 40,
        abortController: controller,
        ...(useBrowser ? { mcpServers } : {}),
      },
    })) {
      addUsage(usage, extractUsage(msg));
      await streamLogToDb(runId, 'research', msg);
    }
  } catch (e) {
    if (controller.signal.aborted) throw new CancelledError();
    const rl = detectRateLimit(e);
    if (rl) throw rl;
    // Salvage: if research.json was already written and parses, a late SDK
    // crash (e.g. a stray Read that tripped MaxFileReadTokenExceededError) is
    // recoverable — the model's useful output is already on disk.
    if (await researchFileUsable(researchPath)) {
      const reason = e instanceof Error ? e.message : String(e);
      await streamLogToDb(
        runId,
        'sys',
        `research sdk error after research.json written, salvaging: ${reason}`,
        'warn',
      );
    } else {
      throw e;
    }
  } finally {
    clearInterval(cancelWatch);
  }

  const cancelledAfterSdk = await prisma.run.findUnique({
    where: { id: runId },
    select: { cancelRequested: true },
  });
  if (cancelledAfterSdk?.cancelRequested) throw new CancelledError();

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
