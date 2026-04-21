import type { Job } from '@prisma/client';
import { prisma } from './index.js';

export type PreflightResult =
  | { kind: 'ok' }
  | { kind: 'skip'; reason: string }
  | { kind: 'defer'; reason: string };

export function startOfMonthLocal(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

/**
 * Decide whether a new run should be created for this job.
 *
 * - `skip`: no row; cron tick too soon after last run.
 * - `defer`: insert a row with `status='deferred'`, `error=reason`, do not run.
 * - `ok`: proceed to insert a normal `queued` run.
 */
export async function preflightJob(job: Job, now: Date = new Date()): Promise<PreflightResult> {
  if (job.minIntervalMinutes != null && job.minIntervalMinutes > 0 && job.lastRunAt) {
    const gap = now.getTime() - job.lastRunAt.getTime();
    if (gap < job.minIntervalMinutes * 60_000) {
      return {
        kind: 'skip',
        reason: `minIntervalMinutes=${job.minIntervalMinutes}, last run ${Math.round(gap / 1000)}s ago`,
      };
    }
  }

  const monthStart = startOfMonthLocal(now);
  const count = await prisma.run.count({
    where: { jobId: job.id, createdAt: { gte: monthStart } },
  });
  if (count >= job.monthlyBudget) {
    return {
      kind: 'defer',
      reason: `monthly budget exceeded (${count}/${job.monthlyBudget})`,
    };
  }

  return { kind: 'ok' };
}
