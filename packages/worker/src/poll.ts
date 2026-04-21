import { logger, prisma, streamLogToDb } from '@renews/shared';
import { runEmail } from './pipeline/email.js';
import { runRender } from './pipeline/render.js';
import { type ResearchJson, runResearch } from './pipeline/research.js';
import { runSummary } from './pipeline/summarize.js';

const HEARTBEAT_MS = 30_000;

let inFlight = false;

export async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const run = await prisma.run.findFirst({
      where: { status: 'queued' },
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

    let research: ResearchJson;
    if (run.skipResearch && run.researchRaw) {
      research = run.researchRaw as unknown as ResearchJson;
      await streamLogToDb(runId, 'sys', 'skipping research (rerun-stage2): reusing researchRaw');
    } else {
      research = await runResearch(runId, run.job);
    }
    const stage2 = await runSummary(runId, run.job, research);
    const rendered = runRender(run.job, stage2);
    await prisma.run.update({
      where: { id: runId },
      data: { renderedOutput: rendered },
    });
    await runEmail(runId, run.job, stage2, rendered);
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
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    logger.error(`poll: run ${runId} failed:`, msg);
    await prisma.run
      .update({
        where: { id: runId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          heartbeatAt: null,
          error: String(err instanceof Error ? err.message : err),
        },
      })
      .catch((e) => logger.error(`poll: could not mark run ${runId} failed:`, e));
  } finally {
    clearInterval(heartbeat);
  }
}
