import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Claude Agent SDK — integration tests must not make real API calls.
// Each test sets `sdkBehavior` to control what the mocked `query()` does: it
// emits the given SDK messages via the async iterator and optionally writes a
// research.json into the run's cwd before returning.
type SdkBehavior = {
  messages?: unknown[];
  researchJson?: unknown | null; // null → write nothing
  stage2Output?: string; // text emitted by the summary SDK call
};
let sdkBehavior: SdkBehavior = {};

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { cwd?: string; allowedTools?: string[] } }) => {
    const isSummary = Array.isArray(options.allowedTools) && options.allowedTools.length === 0;
    const cwd = options.cwd;
    async function* gen() {
      if (isSummary) {
        const text =
          sdkBehavior.stage2Output ??
          JSON.stringify({
            subject: 'Test subject',
            intro: '',
            items: [],
            empty_reason: 'no items',
          });
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
        };
        return;
      }
      for (const m of sdkBehavior.messages ?? []) yield m;
      if (cwd && sdkBehavior.researchJson !== null && sdkBehavior.researchJson !== undefined) {
        await fs.mkdir(cwd, { recursive: true });
        await fs.writeFile(
          path.join(cwd, 'research.json'),
          JSON.stringify(sdkBehavior.researchJson),
          'utf8',
        );
      }
    }
    return gen();
  },
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async () => ({ messageId: 'test-msg-id' }),
    }),
  },
}));

let pg: StartedPostgreSqlContainer;
let runsDir: string;
let prisma: typeof import('@renews/shared').prisma;
let onFire: typeof import('../onFire.js').onFire;
let tick: typeof import('../poll.js').tick;
let staleRecovery: typeof import('../staleRecovery.js').staleRecovery;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('newsletter')
    .withUsername('newsletter')
    .withPassword('pw')
    .start();

  const url = pg.getConnectionUri();
  process.env.DATABASE_URL = url;

  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'renews-runs-'));
  process.env.RUNS_DIR = runsDir;

  execSync('pnpm prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
    cwd: new URL('../../../../', import.meta.url).pathname,
  });

  ({ prisma } = await import('@renews/shared'));
  ({ onFire } = await import('../onFire.js'));
  ({ tick } = await import('../poll.js'));
  ({ staleRecovery } = await import('../staleRecovery.js'));
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.stop();
  if (runsDir) await fs.rm(runsDir, { recursive: true, force: true });
});

async function createJob(overrides: Partial<{ schedule: string; enabled: boolean }> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `u-${Math.random().toString(36).slice(2)}@e.co`,
      passwordHash: 'x',
      isAdmin: false,
    },
  });
  return prisma.job.create({
    data: {
      userId: user.id,
      name: 'Test',
      enabled: overrides.enabled ?? true,
      schedule: overrides.schedule ?? '0 8 * * *',
      sources: [{ url: 'https://example.com' }],
      topic: 't',
      basePrompt: 'p',
      recipientEmail: 'r@e.co',
    },
  });
}

beforeEach(async () => {
  await prisma.runLog.deleteMany();
  await prisma.run.deleteMany();
  await prisma.job.deleteMany();
  await prisma.user.deleteMany();
  sdkBehavior = {};
  await prisma.setting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      gmailUser: 'test@gmail.com',
      gmailAppPassword: 'pw',
      senderName: 'Test',
    },
    update: {
      gmailUser: 'test@gmail.com',
      gmailAppPassword: 'pw',
      senderName: 'Test',
    },
  });
});

describe('onFire', () => {
  it('inserts a queued run and updates lastRunAt/nextRunAt', async () => {
    const job = await createJob({ schedule: '*/5 * * * *' });
    await onFire(job.id);
    const runs = await prisma.run.findMany({ where: { jobId: job.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('queued');
    const refreshed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(refreshed.lastRunAt).toBeInstanceOf(Date);
    expect(refreshed.nextRunAt).toBeInstanceOf(Date);
  });

  it('skips disabled jobs (race window)', async () => {
    const job = await createJob({ enabled: false });
    await onFire(job.id);
    expect(await prisma.run.count({ where: { jobId: job.id } })).toBe(0);
  });
});

describe('poll.tick (pipeline)', () => {
  it('runs the full pipeline and flips status to success', async () => {
    const job = await createJob();
    const run = await prisma.run.create({ data: { jobId: job.id, status: 'queued' } });
    sdkBehavior = {
      messages: [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Fetching source…' },
              { type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com' } },
            ],
          },
        },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', content: '<html>…</html>' }] },
        },
      ],
      researchJson: {
        fetched_at: '2026-04-21T00:00:00Z',
        items: [
          { source: 'https://example.com', title: 'A', url: 'https://example.com/a', content: 'x' },
        ],
        fetch_errors: [],
      },
    };

    await tick();

    const done = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe('success');
    expect(done.startedAt).toBeInstanceOf(Date);
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.researchRaw).toMatchObject({
      items: [expect.objectContaining({ title: 'A' })],
      fetch_errors: [],
    });
    expect(done.stage2Json).toMatchObject({ subject: 'Test subject' });
    expect(typeof done.renderedOutput).toBe('string');

    const logs = await prisma.runLog.findMany({ where: { runId: run.id } });
    const stages = new Set(logs.map((l) => l.stage));
    expect(stages.has('research')).toBe(true);
    expect(
      logs.some(
        (l) => l.stage === 'sys' && /research_done: 1 items, 0 fetch_errors/.test(l.message),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.stage === 'research' && /^tool: WebFetch\(/.test(l.message))).toBe(
      true,
    );
    expect(logs.some((l) => l.stage === 'research' && /^result: /.test(l.message))).toBe(true);
  });

  it('fails the run when research.json is missing (after retries exhausted)', async () => {
    const job = await createJob();
    const run = await prisma.run.create({ data: { jobId: job.id, status: 'queued' } });
    sdkBehavior = { messages: [], researchJson: null };

    // 3 attempts: each throws; clear nextRunAt between attempts so tick picks it up.
    for (let i = 0; i < 3; i++) {
      await tick();
      await prisma.run.update({ where: { id: run.id }, data: { nextRunAt: null } });
    }

    const done = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe('failed');
    expect(done.error).toBe('research.json missing');
    expect(done.finishedAt).toBeInstanceOf(Date);
  });

  it('truncates items > 25 and content > 800 chars', async () => {
    const job = await createJob();
    const run = await prisma.run.create({ data: { jobId: job.id, status: 'queued' } });
    const longContent = 'x'.repeat(1200);
    sdkBehavior = {
      messages: [],
      researchJson: {
        items: Array.from({ length: 40 }, (_, i) => ({
          source: 's',
          title: `t${i}`,
          url: `u${i}`,
          content: longContent,
        })),
        fetch_errors: [],
      },
    };

    await tick();

    const done = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const raw = done.researchRaw as { items: Array<{ content: string }> };
    expect(raw.items).toHaveLength(25);
    expect(raw.items[0]!.content.length).toBe(800);
  });

  it('skipResearch reuses researchRaw and emits no research-stage logs', async () => {
    const job = await createJob();
    const researchRaw = {
      fetched_at: '2026-04-21T00:00:00Z',
      items: [
        { source: 'https://example.com', title: 'X', url: 'https://example.com/x', content: 'y' },
      ],
      fetch_errors: [],
    };
    const run = await prisma.run.create({
      data: {
        jobId: job.id,
        status: 'queued',
        skipResearch: true,
        researchRaw,
      },
    });
    sdkBehavior = { messages: [], researchJson: null };

    await tick();

    const done = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe('success');
    expect(done.researchRaw).toMatchObject({ items: [expect.objectContaining({ title: 'X' })] });

    const logs = await prisma.runLog.findMany({ where: { runId: run.id } });
    expect(logs.some((l) => l.stage === 'research')).toBe(false);
    expect(logs.some((l) => l.stage === 'sys' && l.message.startsWith('skipping research'))).toBe(
      true,
    );
  });

  it('does not double-claim when ticks race', async () => {
    const job = await createJob();
    const run = await prisma.run.create({ data: { jobId: job.id, status: 'queued' } });
    sdkBehavior = {
      messages: [],
      researchJson: { items: [], fetch_errors: [] },
    };

    await Promise.all([tick(), tick()]);
    const final = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(final.status).toBe('success');
    const sysLogs = await prisma.runLog.findMany({
      where: { runId: run.id, stage: 'sys' },
    });
    expect(sysLogs.filter((l) => l.message.startsWith('research_done:'))).toHaveLength(1);
  });
});

describe('truncation warnings', () => {
  it('emits warn sys log when items > 25 or content > 800', async () => {
    const job = await createJob();
    const run = await prisma.run.create({ data: { jobId: job.id, status: 'queued' } });
    const longContent = 'x'.repeat(1200);
    sdkBehavior = {
      messages: [],
      researchJson: {
        items: Array.from({ length: 30 }, (_, i) => ({
          source: 's',
          title: `t${i}`,
          url: `https://e.co/${i}`,
          content: longContent,
        })),
        fetch_errors: [],
      },
    };

    await tick();

    const logs = await prisma.runLog.findMany({ where: { runId: run.id } });
    expect(
      logs.some(
        (l) => l.stage === 'sys' && l.level === 'warn' && /truncated items to 25/.test(l.message),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.stage === 'sys' && l.level === 'warn' && /truncated content .* to 800/.test(l.message),
      ),
    ).toBe(true);
  });
});

describe('hardening: rate-limit', () => {
  it('marks run deferred with nextRunAt on RateLimitError; no retry', async () => {
    process.env.SIM_RATE_LIMIT = '1';
    try {
      const job = await createJob();
      const run = await prisma.run.create({ data: { jobId: job.id, status: 'queued' } });

      await tick();

      const done = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      expect(done.status).toBe('deferred');
      expect(done.attempt).toBe(0);
      expect(done.nextRunAt).toBeInstanceOf(Date);
      expect(done.error).toMatch(/rate_limit/);
    } finally {
      process.env.SIM_RATE_LIMIT = undefined;
    }
  });
});

describe('hardening: generic retry', () => {
  it('retries twice with nextRunAt backoff and then fails', async () => {
    const job = await createJob();
    const run = await prisma.run.create({ data: { jobId: job.id, status: 'queued' } });
    sdkBehavior = { messages: [], researchJson: null }; // causes "research.json missing"

    // attempt 1 → throws
    await tick();
    let r = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe('queued');
    expect(r.attempt).toBe(1);
    expect(r.nextRunAt).toBeInstanceOf(Date);
    expect(r.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // a second tick immediately shouldn't pick it up (nextRunAt gate)
    await tick();
    r = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe('queued');
    expect(r.attempt).toBe(1);

    // simulate time advancing: clear nextRunAt so it's pickable
    await prisma.run.update({ where: { id: run.id }, data: { nextRunAt: null } });
    await tick();
    r = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe('queued');
    expect(r.attempt).toBe(2);

    // final attempt → failed
    await prisma.run.update({ where: { id: run.id }, data: { nextRunAt: null } });
    await tick();
    r = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/research\.json missing/);
  });
});

describe('hardening: preflight (onFire)', () => {
  it('skips (no row) when within minIntervalMinutes of lastRunAt', async () => {
    const job = await createJob({ schedule: '* * * * *' });
    const recent = new Date(Date.now() - 2 * 60_000);
    await prisma.job.update({
      where: { id: job.id },
      data: { minIntervalMinutes: 10, lastRunAt: recent },
    });

    await onFire(job.id);

    const runs = await prisma.run.findMany({ where: { jobId: job.id } });
    expect(runs).toHaveLength(0);
  });

  it('creates deferred row when monthlyBudget exhausted', async () => {
    const job = await createJob();
    await prisma.job.update({ where: { id: job.id }, data: { monthlyBudget: 1 } });
    // existing run this month
    await prisma.run.create({ data: { jobId: job.id, status: 'success' } });

    await onFire(job.id);

    const runs = await prisma.run.findMany({
      where: { jobId: job.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(runs).toHaveLength(2);
    expect(runs[1]!.status).toBe('deferred');
    expect(runs[1]!.error).toMatch(/monthly budget exceeded/);
  });
});

describe('staleRecovery', () => {
  it('resets stale running runs to queued', async () => {
    const job = await createJob();
    const old = new Date(Date.now() - 10 * 60_000);
    const run = await prisma.run.create({
      data: { jobId: job.id, status: 'running', startedAt: old, heartbeatAt: old },
    });
    const count = await staleRecovery();
    expect(count).toBe(1);
    const r = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe('queued');
    expect(r.heartbeatAt).toBeNull();
  });

  it('leaves fresh running runs alone', async () => {
    const job = await createJob();
    const run = await prisma.run.create({
      data: { jobId: job.id, status: 'running', startedAt: new Date(), heartbeatAt: new Date() },
    });
    const count = await staleRecovery();
    expect(count).toBe(0);
    const r = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe('running');
  });
});
