import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __renewsPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient = global.__renewsPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') global.__renewsPrisma = prisma;

export const logger = {
  info: (...args: unknown[]) => console.log('[info]', ...args),
  warn: (...args: unknown[]) => console.warn('[warn]', ...args),
  error: (...args: unknown[]) => console.error('[error]', ...args),
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG) console.log('[debug]', ...args);
  },
};

export * from './schemas.js';
export * from './cron.js';
export * from './logger.js';
export * from './preflight.js';
