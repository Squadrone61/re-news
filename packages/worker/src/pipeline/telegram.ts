import type { Job } from '@prisma/client';
import { type StageTwo, prisma, renderTelegramHtml, streamLogToDb } from '@renews/shared';
import { TelegramApiError, type TgMessage, tg } from '../telegram/client.js';
import { RateLimitError } from './errors.js';

export async function runTelegram(
  runId: string,
  job: Job,
  parsed: StageTwo,
  _rendered: string,
): Promise<void> {
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  if (!settings?.telegramBotToken) {
    throw new Error('telegram settings incomplete (telegram_bot_token)');
  }
  if (!job.telegramChatId) {
    throw new Error('telegram not linked (chat_id missing)');
  }

  const chunks = renderTelegramHtml(parsed);
  const messageIds: number[] = [];

  for (const text of chunks) {
    try {
      const msg = await tg<TgMessage>(settings.telegramBotToken, 'sendMessage', {
        chat_id: job.telegramChatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      });
      messageIds.push(msg.message_id);
    } catch (e) {
      if (e instanceof TelegramApiError && e.retryAfter != null && e.retryAfter > 0) {
        const resetAt = new Date(Date.now() + e.retryAfter * 1000);
        throw new RateLimitError(`telegram rate_limit: retry after ${e.retryAfter}s`, resetAt);
      }
      throw new Error(`telegram send: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await streamLogToDb(
    runId,
    'telegram',
    `sent to chat ${job.telegramChatId} (${messageIds.length} message(s), ids=${messageIds.join(',')})`,
  );
}
