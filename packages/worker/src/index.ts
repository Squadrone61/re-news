import { randomBytes } from 'node:crypto';
import { constants, access, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { logger } from '@renews/shared';
import cron, { type ScheduledTask } from 'node-cron';
import { refresh as refreshAccountInfo } from './accountInfo.js';
import { run as runCleanup } from './cleanup.js';
import { tick } from './poll.js';
import { reconcile, stopAll } from './registry.js';
import { staleRecovery } from './staleRecovery.js';

const CLAUDE_DIR = '/root/.claude';
const POLL_MS = 5_000;
const RECONCILE_MS = 60_000;
const ACCOUNT_INFO_MS = 5 * 60_000;
const CLEANUP_CRON = '0 3 * * *';

async function verifyClaudeMount(): Promise<void> {
  try {
    await access(CLAUDE_DIR, constants.R_OK | constants.W_OK);
  } catch {
    logger.warn(
      `claude mount: ${CLAUDE_DIR} not accessible (R/W). SDK auth will fail until fixed.`,
    );
    return;
  }
  const probe = join(CLAUDE_DIR, `.renews-write-probe-${randomBytes(4).toString('hex')}`);
  try {
    await writeFile(probe, 'ok');
    await unlink(probe);
    logger.info(`claude mount: ${CLAUDE_DIR} is mounted and writable`);
  } catch (err) {
    logger.warn(`claude mount: ${CLAUDE_DIR} exists but write probe failed:`, err);
  }
}

let shuttingDown = false;
let pollTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let accountInfoTimer: NodeJS.Timeout | null = null;
let cleanupTask: ScheduledTask | null = null;

function installSignalHandlers(): void {
  const shutdown = async (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${sig}, shutting down`);
    if (pollTimer) clearInterval(pollTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (accountInfoTimer) clearInterval(accountInfoTimer);
    if (cleanupTask) {
      try {
        await cleanupTask.stop();
        await cleanupTask.destroy();
      } catch (err) {
        logger.warn('cleanup cron stop failed:', err);
      }
    }
    try {
      await stopAll();
    } catch (err) {
      logger.warn('stopAll failed during shutdown:', err);
    }
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function main(): Promise<void> {
  logger.info('worker booted');
  installSignalHandlers();
  await verifyClaudeMount();

  await staleRecovery();
  await reconcile();
  refreshAccountInfo().catch((err) => logger.warn('account_info initial refresh failed:', err));

  accountInfoTimer = setInterval(() => {
    if (shuttingDown) return;
    refreshAccountInfo().catch((err) => logger.warn('account_info refresh failed:', err));
  }, ACCOUNT_INFO_MS);

  cleanupTask = cron.schedule(CLEANUP_CRON, () => {
    runCleanup().catch((err) => logger.error('cleanup failed:', err));
  });
  logger.info(`cleanup cron registered (${CLEANUP_CRON})`);

  reconcileTimer = setInterval(() => {
    if (shuttingDown) return;
    reconcile().catch((err) => logger.error('reconcile failed:', err));
  }, RECONCILE_MS);

  pollTimer = setInterval(() => {
    if (shuttingDown) return;
    tick().catch((err) => logger.error('poll tick failed:', err));
  }, POLL_MS);

  logger.info(
    `worker running (poll=${POLL_MS}ms, reconcile=${RECONCILE_MS}ms, account_info=${ACCOUNT_INFO_MS}ms)`,
  );
}

main().catch((err) => {
  logger.error('worker crashed:', err);
  process.exit(1);
});
