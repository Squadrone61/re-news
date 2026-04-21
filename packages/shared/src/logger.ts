import { prisma } from './index.js';

export type LogStage = 'research' | 'summary' | 'email' | 'sys';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export async function streamLogToDb(
  runId: string,
  stage: LogStage,
  message: string,
  level: LogLevel = 'info',
): Promise<void> {
  await prisma.runLog.create({
    data: { runId, stage, message, level },
  });
}
