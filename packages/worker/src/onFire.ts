import { logger, nextFireAt, preflightJob, prisma } from '@renews/shared';

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
  const pre = await preflightJob(job, now);

  if (pre.kind === 'skip') {
    logger.info(`onFire: job ${job.id} skipped (${pre.reason})`);
    await prisma.job.update({
      where: { id: job.id },
      data: { nextRunAt: nextFireAt(job.schedule, now) },
    });
    return;
  }

  if (pre.kind === 'defer') {
    const deferred = await prisma.run.create({
      data: { jobId: job.id, status: 'deferred', error: pre.reason, finishedAt: now },
      select: { id: true },
    });
    await prisma.job.update({
      where: { id: job.id },
      data: { nextRunAt: nextFireAt(job.schedule, now) },
    });
    logger.info(`onFire: deferred run ${deferred.id} for job ${job.id} (${pre.reason})`);
    return;
  }

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
