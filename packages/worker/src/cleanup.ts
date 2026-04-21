import fs from 'node:fs/promises';
import path from 'node:path';
import { logger, prisma, streamLogToDb } from '@renews/shared';

const RUNS_ROOT = process.env.RUNS_DIR ?? '/app/data/runs';
const RETENTION_DAYS = 30;

export async function run(now: Date = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const old = await prisma.run.findMany({
    where: { finishedAt: { lt: cutoff } },
    select: { id: true },
  });

  let deleted = 0;
  for (const { id } of old) {
    const dir = path.join(RUNS_ROOT, id);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      deleted++;
    } catch (err) {
      logger.warn(`cleanup: failed to remove ${dir}:`, err);
    }
  }

  logger.info(`cleanup: deleted ${deleted} dirs (older than ${RETENTION_DAYS} days)`);

  if (old.length > 0) {
    const firstId = old[0]!.id;
    await streamLogToDb(firstId, 'sys', `cleanup: deleted ${deleted} dirs`).catch(() => {});
  }

  return { deleted };
}
