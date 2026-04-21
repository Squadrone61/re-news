import { logger, prisma } from '@renews/shared';
import { stubPipeline } from './pipeline.js';

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
    await stubPipeline(runId);
    await prisma.run.update({
      where: { id: runId },
      data: { status: 'success', finishedAt: new Date(), heartbeatAt: null },
    });
    logger.info(`poll: run ${runId} success`);
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
