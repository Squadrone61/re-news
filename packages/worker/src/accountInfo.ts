import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@renews/shared';

const OUT_DIR = process.env.ACCOUNT_INFO_DIR ?? '/app/data';
const OUT_FILE = 'account_info.json';

type AccountInfo = {
  plan?: string;
  tier?: string;
  email?: string;
  refreshedAt: string;
};

export async function refresh(): Promise<void> {
  try {
    const info = await fetchAccountInfo();
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, OUT_FILE), JSON.stringify(info, null, 2));
    logger.info(`account_info refreshed (plan=${info.plan ?? 'unknown'})`);
  } catch (err) {
    logger.warn('account_info refresh failed:', err);
  }
}

async function fetchAccountInfo(): Promise<AccountInfo> {
  // The SDK's AccountInfo surface has shifted across versions. Best-effort:
  // try the dynamic import; if anything throws, write an empty record with a
  // timestamp so the web UI can at least show "refreshed at".
  const out: AccountInfo = { refreshedAt: new Date().toISOString() };
  try {
    const mod = (await import('@anthropic-ai/claude-agent-sdk')) as Record<string, unknown>;
    const candidates = ['getAccountInfo', 'accountInfo', 'AccountInfo'] as const;
    for (const key of candidates) {
      const fn = mod[key];
      if (typeof fn === 'function') {
        try {
          const r = (await (fn as () => unknown)()) as Record<string, unknown> | undefined;
          if (r && typeof r === 'object') {
            if (typeof r.plan === 'string') out.plan = r.plan;
            if (typeof r.tier === 'string') out.tier = r.tier;
            if (typeof r.email === 'string') out.email = r.email;
          }
          break;
        } catch {
          // keep trying other candidates
        }
      }
    }
  } catch {
    // SDK unavailable — leave out blank
  }
  return out;
}
