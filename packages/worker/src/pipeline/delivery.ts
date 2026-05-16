import type { Job } from '@prisma/client';
import type { StageTwo } from '@renews/shared';
import { runEmail } from './email.js';
import { runTelegram } from './telegram.js';

export async function runDelivery(
  runId: string,
  job: Job,
  parsed: StageTwo,
  rendered: string,
): Promise<void> {
  if (job.deliveryChannel === 'telegram') {
    return runTelegram(runId, job, parsed, rendered);
  }
  return runEmail(runId, job, parsed, rendered);
}
