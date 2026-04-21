import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let pg: StartedPostgreSqlContainer;
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

describe('poll.tick', () => {
  it('claims a queued run and drives it to success via stub pipeline', async () => {
    const job = await createJob();
    const run = await prisma.run.create({ data: { jobId: job.id, status: 'queued' } });
    await tick();
    const done = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe('success');
    expect(done.startedAt).toBeInstanceOf(Date);
    expect(done.finishedAt).toBeInstanceOf(Date);
    const logs = await prisma.runLog.findMany({
      where: { runId: run.id, stage: 'sys' },
    });
    expect(logs.some((l) => l.message.includes('received run'))).toBe(true);
  });

  it('does not double-claim when ticks race', async () => {
    const job = await createJob();
    const run = await prisma.run.create({ data: { jobId: job.id, status: 'queued' } });
    await Promise.all([tick(), tick()]);
    const final = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(final.status).toBe('success');
    const sysLogs = await prisma.runLog.findMany({
      where: { runId: run.id, stage: 'sys', message: { contains: 'received run' } },
    });
    expect(sysLogs).toHaveLength(1);
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
