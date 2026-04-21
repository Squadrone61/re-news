import { logger, prisma } from '@renews/shared';

const STALE_MS = 5 * 60 * 1000;

export async function staleRecovery(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_MS);
  const res = await prisma.run.updateMany({
    where: {
      status: 'running',
      OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: cutoff } }],
    },
    data: { status: 'queued', heartbeatAt: null, startedAt: null },
  });
  if (res.count > 0)
    logger.info(`staleRecovery: reset ${res.count} stale running run(s) to queued`);
  return res.count;
}
