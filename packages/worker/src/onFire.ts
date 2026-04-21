import { logger, nextFireAt, prisma } from '@renews/shared';

export async function onFire(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    logger.warn(`onFire: job ${jobId} not found (deleted?); skipping`);
    return;
  }
  if (!job.enabled) {
    logger.info(`onFire: job ${jobId} disabled; skipping`);
    return;
  }

  const now = new Date();
  const run = await prisma.run.create({
    data: { jobId: job.id, status: 'queued' },
    select: { id: true },
  });
  await prisma.job.update({
    where: { id: job.id },
    data: { lastRunAt: now, nextRunAt: nextFireAt(job.schedule, now) },
  });
  logger.info(`onFire: queued run ${run.id} for job ${job.id} (${job.name})`);
}
