import { logger, prisma, streamLogToDb } from '@renews/shared';
import { runEmail } from './pipeline/email.js';
import { CancelledError, RateLimitError, detectRateLimit } from './pipeline/errors.js';
import { sendFailureNotice } from './pipeline/failureNotice.js';
import { runRender } from './pipeline/render.js';
import { type ResearchJson, runResearch } from './pipeline/research.js';
import { runSummary } from './pipeline/summarize.js';
import { emptyUsage, persistUsage } from './pipeline/usage.js';

const HEARTBEAT_MS = 30_000;
const MAX_ATTEMPTS = 3; // attempt is 0-indexed; 3 total tries
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000]; // attempt 0→1: 1m, 1→2: 5m

let inFlight = false;

async function throwIfCancelled(runId: string): Promise<void> {
  const r = await prisma.run.findUnique({
    where: { id: runId },
    select: { cancelRequested: true },
  });
  if (r?.cancelRequested) throw new CancelledError();
}

export async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const now = new Date();
    const run = await prisma.run.findFirst({
      where: {
        status: 'queued',
        OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!run) return;

    const claimed = await prisma.run.updateMany({
      where: { id: run.id, status: 'queued' },
      data: { status: 'running', startedAt: new Date(), heartbeatAt: new Date() },
    });
    if (claimed.count === 0) return;

    await execute(run.id);
  } finally {
    inFlight = false;
  }
}

async function execute(runId: string): Promise<void> {
  logger.info(`poll: executing run ${runId}`);
  const heartbeat = setInterval(() => {
    prisma.run
      .update({ where: { id: runId }, data: { heartbeatAt: new Date() } })
      .catch((err) => logger.warn(`heartbeat failed for ${runId}:`, err));
  }, HEARTBEAT_MS);

  try {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { job: true },
    });
    if (!run) throw new Error(`run ${runId} not found`);

    const usage = emptyUsage();
    let research: ResearchJson;
    if (run.skipResearch && run.researchRaw) {
      research = run.researchRaw as unknown as ResearchJson;
      await streamLogToDb(runId, 'sys', 'skipping research (rerun-stage2): reusing researchRaw');
    } else {
      research = await runResearch(runId, run.job, usage);
    }
    await throwIfCancelled(runId);

    const stage2 = await runSummary(runId, run.job, research, usage);
    await throwIfCancelled(runId);

    const rendered = runRender(run.job, stage2);
    await prisma.run.update({
      where: { id: runId },
      data: { renderedOutput: rendered },
    });
    await throwIfCancelled(runId);

    await runEmail(runId, run.job, stage2, rendered);
    await persistUsage(runId, usage);
    await prisma.run.update({
      where: { id: runId },
      data: { status: 'success', finishedAt: new Date(), heartbeatAt: null },
    });
    await prisma.job.update({
      where: { id: run.jobId },
      data: { lastRunAt: new Date() },
    });
    logger.info(`poll: run ${runId} complete`);
  } catch (err) {
    clearInterval(heartbeat);
    await handleFailure(runId, err);
    return;
  }
  clearInterval(heartbeat);
}

async function handleFailure(runId: string, err: unknown): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  const errStack = err instanceof Error ? err.stack || err.message : String(err);
  logger.error(`poll: run ${runId} failed:`, errStack);

  if (err instanceof CancelledError) {
    await prisma.run
      .update({
        where: { id: runId },
        data: {
          status: 'cancelled',
          finishedAt: new Date(),
          heartbeatAt: null,
          cancelRequested: false,
          error: 'cancelled by user',
        },
      })
      .catch((e) => logger.error(`poll: could not mark run ${runId} cancelled:`, e));
    await streamLogToDb(runId, 'sys', 'cancelled by user', 'warn').catch(() => {});
    return;
  }

  const rl = err instanceof RateLimitError ? err : detectRateLimit(err);
  if (rl) {
    await prisma.run
      .update({
        where: { id: runId },
        data: {
          status: 'deferred',
          finishedAt: new Date(),
          heartbeatAt: null,
          nextRunAt: rl.resetAt,
          error: rl.message,
        },
      })
      .catch((e) => logger.error(`poll: could not mark run ${runId} deferred:`, e));
    await streamLogToDb(runId, 'sys', rl.message, 'warn').catch(() => {});
    return;
  }

  const current = await prisma.run
    .findUnique({ where: { id: runId }, select: { attempt: true } })
    .catch(() => null);
  const attempt = current?.attempt ?? 0;

  if (attempt + 1 < MAX_ATTEMPTS) {
    const backoff = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
    const nextAt = new Date(Date.now() + backoff);
    await prisma.run
      .update({
        where: { id: runId },
        data: {
          status: 'queued',
          startedAt: null,
          heartbeatAt: null,
          nextRunAt: nextAt,
          attempt: { increment: 1 },
          error: errMsg,
        },
      })
      .catch((e) => logger.error(`poll: could not requeue run ${runId}:`, e));
    await streamLogToDb(
      runId,
      'sys',
      `retry ${attempt + 1}/${MAX_ATTEMPTS - 1} scheduled at ${nextAt.toISOString()}: ${errMsg}`,
      'warn',
    ).catch(() => {});
    return;
  }

  await prisma.run
    .update({
      where: { id: runId },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        heartbeatAt: null,
        error: errMsg,
      },
    })
    .catch((e) => logger.error(`poll: could not mark run ${runId} failed:`, e));

  await sendFailureNotice(runId);
}
