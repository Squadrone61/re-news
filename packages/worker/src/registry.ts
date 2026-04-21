import { logger, prisma } from '@renews/shared';
import cron, { type ScheduledTask } from 'node-cron';
import { onFire } from './onFire.js';

type Entry = { task: ScheduledTask; schedule: string };

const tasks = new Map<string, Entry>();

function register(jobId: string, schedule: string): void {
  const task = cron.schedule(schedule, () => {
    onFire(jobId).catch((err) => logger.error(`onFire(${jobId}) failed:`, err));
  });
  tasks.set(jobId, { task, schedule });
  logger.info(`registry: registered job ${jobId} (${schedule})`);
}

async function unregister(jobId: string): Promise<void> {
  const entry = tasks.get(jobId);
  if (!entry) return;
  try {
    await entry.task.stop();
    await entry.task.destroy();
  } catch (err) {
    logger.warn(`registry: stop failed for ${jobId}:`, err);
  }
  tasks.delete(jobId);
  logger.info(`registry: unregistered job ${jobId}`);
}

export async function reconcile(): Promise<void> {
  const jobs = await prisma.job.findMany({
    where: { enabled: true },
    select: { id: true, schedule: true },
  });
  const live = new Set(jobs.map((j) => j.id));

  for (const [id] of tasks) {
    if (!live.has(id)) await unregister(id);
  }

  for (const job of jobs) {
    const entry = tasks.get(job.id);
    if (!entry) {
      register(job.id, job.schedule);
    } else if (entry.schedule !== job.schedule) {
      await unregister(job.id);
      register(job.id, job.schedule);
    }
  }
}

export async function stopAll(): Promise<void> {
  for (const [id] of Array.from(tasks)) {
    await unregister(id);
  }
}

export function registeredCount(): number {
  return tasks.size;
}
