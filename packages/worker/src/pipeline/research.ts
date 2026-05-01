import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Job } from '@prisma/client';
import { prisma, streamLogToDb, summarizeFetchErrors } from '@renews/shared';
import { CONDUCTOR_SYSTEM_PROMPT, buildConductorInput } from '../prompts/conductor.js';
import { RESEARCH_SUBAGENT_SYSTEM_PROMPT } from '../prompts/researchSubagent.js';
import { CancelledError, RateLimitError, detectRateLimit } from './errors.js';
import { salvageFromSources } from './salvage.js';
import type { Stage1Outcome } from './stage1Outcome.js';
import { type UsageTotals, addUsage, emptyUsage, extractUsage } from './usage.js';

const RUNS_ROOT = process.env.RUNS_DIR ?? '/app/data/runs';
const MAX_MERGED_ITEMS = 50; // safety belt only — conductor prompt asks for 25

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
  const req = createRequire(import.meta.url);
  const pkgJsonPath = req.resolve('@playwright/mcp/package.json');
  cachedPlaywrightMcpCli = path.join(path.dirname(pkgJsonPath), 'cli.js');
  return cachedPlaywrightMcpCli;
}

let cachedChromiumPath: string | null = null;
async function resolvePatchrightChromium(): Promise<string> {
  if (cachedChromiumPath) return cachedChromiumPath;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/ms-playwright';
  const entries = await fs.readdir(root, { withFileTypes: true });
  const chromiumDir = entries.find((e) => e.isDirectory() && e.name.startsWith('chromium-'));
  if (!chromiumDir) {
    throw new Error(`patchright Chromium not found under ${root}`);
  }
  // patchright ships chromium under chrome-linux64/, older playwright used chrome-linux/.
  const candidates = [
    path.join(root, chromiumDir.name, 'chrome-linux64', 'chrome'),
    path.join(root, chromiumDir.name, 'chrome-linux', 'chrome'),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      cachedChromiumPath = c;
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(`Chromium binary not found under ${path.join(root, chromiumDir.name)}`);
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

export async function runResearch(
  runId: string,
  job: Job,
  usage: UsageTotals = emptyUsage(),
): Promise<Stage1Outcome> {
  if (process.env.SIM_RATE_LIMIT === '1') {
    throw new RateLimitError('rate_limit: simulated', new Date(Date.now() + 3600 * 1000));
  }

  const cwd = path.join(RUNS_ROOT, runId);
  await fs.mkdir(path.join(cwd, 'sources'), { recursive: true });

  const useBrowser = jobHasBrowserSources(job);
  const subagentTools = ['WebFetch', 'WebSearch', 'Bash', 'Read', 'Write'];
  if (useBrowser) subagentTools.push(...BROWSER_TOOLS);
  const conductorTools = ['Task', 'WebSearch', 'Read', 'Write'];

  const mcpServers: Record<string, { command: string; args?: string[] }> = {};
  if (useBrowser) {
    const chromiumExe = await resolvePatchrightChromium();
    mcpServers.playwright = {
      command: process.execPath,
      args: [
        resolvePlaywrightMcpCli(),
        '--browser=chromium',
        '--headless',
        '--isolated',
        `--executable-path=${chromiumExe}`,
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
        /* transient DB read failure — next tick retries */
      });
  }, 1000);

  let sdkErr: unknown = null;
  try {
    for await (const msg of query({
      prompt: buildConductorInput(job),
      options: {
        systemPrompt: CONDUCTOR_SYSTEM_PROMPT,
        allowedTools: conductorTools,
        permissionMode: 'acceptEdits',
        // Worker is unattended; auto-grant every tool we declared. `acceptEdits`
        // alone covers only Edit/Write — WebFetch and MCP tools (Playwright)
        // would otherwise prompt for grants no one is there to give and the
        // subagent's tool call would surface as `permission_denied` instead of
        // actually fetching. `bypassPermissions` requires trust-dialog
        // acceptance the headless container can't perform, so we use the
        // `canUseTool` callback instead — it grants per-tool without touching
        // session-wide bypass state.
        canUseTool: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
        cwd,
        model: 'claude-haiku-4-5',
        maxTurns: 6,
        abortController: controller,
        agents: {
          'research-source': {
            description: 'Fetch ONE source URL and write sources/<index>.json',
            prompt: RESEARCH_SUBAGENT_SYSTEM_PROMPT,
            tools: subagentTools,
            model: 'sonnet',
          },
        },
        ...(useBrowser ? { mcpServers } : {}),
      },
    })) {
      addUsage(usage, extractUsage(msg));
      await streamLogToDb(runId, 'research', msg);
    }
  } catch (e) {
    if (controller.signal.aborted) {
      clearInterval(cancelWatch);
      throw new CancelledError();
    }
    const rl = detectRateLimit(e);
    if (rl) {
      clearInterval(cancelWatch);
      throw rl;
    }
    sdkErr = e;
    await streamLogToDb(
      runId,
      'sys',
      `conductor sdk error, attempting salvage: ${errMsg(e)}`,
      'warn',
    );
  } finally {
    clearInterval(cancelWatch);
  }

  const cancelled = await prisma.run.findUnique({
    where: { id: runId },
    select: { cancelRequested: true },
  });
  if (cancelled?.cancelRequested) throw new CancelledError();

  const researchPath = path.join(cwd, 'research.json');
  let conductorWroteResearch = false;
  let researchFromConductor: ResearchJson | null = null;
  try {
    const raw = await fs.readFile(researchPath, 'utf8');
    researchFromConductor = JSON.parse(raw) as ResearchJson;
    conductorWroteResearch = true;
  } catch {
    /* fall through to salvage */
  }

  if (conductorWroteResearch && researchFromConductor) {
    const cleaned = await validateAndWarnLengths(runId, researchFromConductor);
    await persist(runId, cleaned);
    return { kind: 'complete', research: cleaned };
  }

  // Conductor didn't write research.json — salvage from sources/*.json.
  const sal = await salvageFromSources(cwd);
  for (const s of sal.skipped) {
    await streamLogToDb(runId, 'sys', `salvage skipped sources/${s.file}: ${s.reason}`, 'warn');
  }
  if (sal.salvagedCount > 0) {
    const cleaned = await validateAndWarnLengths(runId, sal.research);
    await persist(runId, cleaned);
    await streamLogToDb(
      runId,
      'sys',
      `stage1 salvaged ${sal.salvagedCount} source(s) after conductor crash`,
      'warn',
    );
    return {
      kind: 'partial',
      research: cleaned,
      salvagedFromSources: sal.salvagedCount,
    };
  }

  // Nothing on disk. Distinguish "sdk crashed before any source completed"
  // from "conductor finished but emitted no signal".
  if (sdkErr) {
    return { kind: 'aborted', reason: errMsg(sdkErr) };
  }
  return { kind: 'no_signal', reason: 'conductor produced no research.json and no sources/*.json' };
}

async function persist(runId: string, research: ResearchJson): Promise<void> {
  await prisma.run.update({
    where: { id: runId },
    data: { researchRaw: research as object },
  });
  const nItems = research.items?.length ?? 0;
  const summary = summarizeFetchErrors(research);
  await streamLogToDb(
    runId,
    'sys',
    `research_done: ${nItems} items, ${summary.total} fetch_errors`,
  );
  if (summary.total > 0) {
    const breakdown = Object.entries(summary.byCode)
      .map(([code, n]) => `${code}×${n}`)
      .join(', ');
    await streamLogToDb(runId, 'sys', `fetch_errors breakdown: ${breakdown}`, 'warn');
  }
}

async function validateAndWarnLengths(runId: string, parsed: ResearchJson): Promise<ResearchJson> {
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const errors = Array.isArray(parsed.fetch_errors) ? parsed.fetch_errors : [];
  const oversized: Array<{ url: string; len: number }> = [];
  for (const it of rawItems) {
    const summary = (it as Record<string, unknown>).summary;
    if (typeof summary === 'string' && summary.length > 800) {
      oversized.push({
        url: typeof it.url === 'string' ? it.url : 'unknown',
        len: summary.length,
      });
    }
  }
  for (const v of oversized) {
    await streamLogToDb(
      runId,
      'sys',
      `oversized summary (${v.len} > 800) for ${v.url} — passed through, not truncated`,
      'warn',
    );
  }
  let items = rawItems;
  if (rawItems.length > MAX_MERGED_ITEMS) {
    await streamLogToDb(
      runId,
      'sys',
      `safety-belt: dropped ${rawItems.length - MAX_MERGED_ITEMS} items above MAX_MERGED_ITEMS=${MAX_MERGED_ITEMS}`,
      'warn',
    );
    items = rawItems.slice(0, MAX_MERGED_ITEMS);
  }
  return {
    fetched_at:
      typeof parsed.fetched_at === 'string' ? parsed.fetched_at : new Date().toISOString(),
    items,
    fetch_errors: errors,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
