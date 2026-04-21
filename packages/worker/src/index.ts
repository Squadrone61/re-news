import { randomBytes } from 'node:crypto';
import { constants, access, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { logger } from '@renews/shared';

const CLAUDE_DIR = '/root/.claude';

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
function installSignalHandlers(): void {
  const shutdown = (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${sig}, shutting down`);
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function main(): Promise<void> {
  logger.info('worker booted');
  installSignalHandlers();
  await verifyClaudeMount();
  // Idle heartbeat — plan 3 replaces this with the real loop.
  // Ref'd timer keeps the event loop alive until SIGTERM/SIGINT.
  setInterval(() => {
    if (!shuttingDown) logger.debug('idle');
  }, 30_000);
}

main().catch((err) => {
  logger.error('worker crashed:', err);
  process.exit(1);
});
