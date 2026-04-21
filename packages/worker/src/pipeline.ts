import { streamLogToDb } from '@renews/shared';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function stubPipeline(runId: string): Promise<void> {
  await streamLogToDb(runId, 'sys', `received run ${runId}`);
  await sleep(1000);
}
