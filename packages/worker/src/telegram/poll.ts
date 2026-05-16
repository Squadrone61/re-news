import { logger, prisma } from '@renews/shared';
import { TelegramApiError, type TgUpdate, tg } from './client.js';

/**
 * Long-poll Telegram's getUpdates and redeem link tokens. Runs alongside the
 * 5s DB poll in worker/index.ts. One in-flight call at a time; loop yields
 * to the event loop after each batch via `setImmediate`.
 *
 * Self-heals: if the bot token is missing, sleeps and retries — admin can
 * set it later via Settings UI without restarting the worker.
 */

const POLL_TIMEOUT_S = 25; // long-poll: server holds the connection up to 25s
const NO_TOKEN_RETRY_MS = 30_000;
const TRANSIENT_ERROR_RETRY_MS = 5_000;

let stopped = false;

export function stopTelegramPoll(): void {
  stopped = true;
}

export async function runTelegramPoll(): Promise<void> {
  logger.info('telegram: getUpdates loop started');
  while (!stopped) {
    try {
      await onePass();
    } catch (e) {
      logger.warn(`telegram: poll pass crashed: ${e instanceof Error ? e.message : String(e)}`);
      await sleep(TRANSIENT_ERROR_RETRY_MS);
    }
  }
  logger.info('telegram: getUpdates loop stopped');
}

async function onePass(): Promise<void> {
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  if (!settings?.telegramBotToken) {
    await sleep(NO_TOKEN_RETRY_MS);
    return;
  }
  const token = settings.telegramBotToken;

  // Lazy: cache the bot username so the web UI can build deep links.
  if (!settings.telegramBotUsername) {
    await cacheBotUsername(token).catch((e) =>
      logger.warn(`telegram: getMe failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  let updates: TgUpdate[];
  try {
    updates = await tg<TgUpdate[]>(token, 'getUpdates', {
      offset: Number(settings.telegramUpdateOffset),
      timeout: POLL_TIMEOUT_S,
      allowed_updates: ['message', 'my_chat_member'],
    });
  } catch (e) {
    if (e instanceof TelegramApiError && e.retryAfter && e.retryAfter > 0) {
      await sleep(e.retryAfter * 1000);
      return;
    }
    // 401 means a bad token. Don't hot-loop; user can fix via Settings UI.
    if (e instanceof TelegramApiError && e.statusCode === 401) {
      logger.warn('telegram: getUpdates 401 — bot token rejected. Sleeping.');
      await sleep(NO_TOKEN_RETRY_MS);
      return;
    }
    throw e;
  }

  if (updates.length === 0) return;

  let maxId = Number(settings.telegramUpdateOffset) - 1;
  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    try {
      await handleUpdate(token, u);
    } catch (e) {
      logger.warn(
        `telegram: update ${u.update_id} handler crashed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  await prisma.setting.update({
    where: { id: 1 },
    data: { telegramUpdateOffset: BigInt(maxId + 1) },
  });
}

async function handleUpdate(token: string, u: TgUpdate): Promise<void> {
  if (!u.message?.text) return;
  const text = u.message.text.trim();
  const chat = u.message.chat;

  // Match /start <token> (DM) or /link <token> (group). Strip optional @botname.
  const m = text.match(/^\/(start|link)(?:@\w+)?\s+([A-Za-z0-9_-]{8,128})\b/);
  if (!m) return;

  const cmd = m[1] as 'start' | 'link';
  const linkToken = m[2]!;
  const expectedKind: 'dm' | 'group' = cmd === 'start' ? 'dm' : 'group';

  const row = await prisma.jobLinkToken.findUnique({
    where: { token: linkToken },
    include: { job: { select: { id: true, name: true } } },
  });

  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    await reply(token, chat.id, '⚠️ Link expired or invalid.');
    return;
  }
  if (row.kind !== expectedKind) {
    await reply(
      token,
      chat.id,
      `⚠️ This link is for ${row.kind === 'dm' ? 'a direct message' : 'a group'}; use the matching button in the web UI.`,
    );
    return;
  }

  await prisma.$transaction([
    prisma.job.update({
      where: { id: row.jobId },
      data: {
        telegramChatId: String(chat.id),
        telegramChatType: expectedKind,
        telegramChatTitle: chat.title ?? chat.username ?? null,
      },
    }),
    prisma.jobLinkToken.update({
      where: { token: linkToken },
      data: { usedAt: new Date() },
    }),
  ]);

  await reply(
    token,
    chat.id,
    `✅ Linked to job <b>${escapeTg(row.job.name)}</b>. Future newsletters will arrive here.`,
  );
}

async function reply(token: string, chatId: number, text: string): Promise<void> {
  try {
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (e) {
    logger.warn(
      `telegram: reply to ${chatId} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function cacheBotUsername(token: string): Promise<void> {
  const me = await tg<{ username?: string }>(token, 'getMe');
  if (me.username) {
    await prisma.setting.update({
      where: { id: 1 },
      data: { telegramBotUsername: me.username },
    });
    logger.info(`telegram: bot username cached as @${me.username}`);
  }
}

function escapeTg(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
