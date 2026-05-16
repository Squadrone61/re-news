import { prisma } from '@renews/shared';

/**
 * Web-side Telegram sender. Mirrors `mailer.ts`: reads settings on every
 * call (so rotated bot tokens take effect immediately), throws with the
 * worker's error-string conventions on failure. Used by /api/runs/:id/resend.
 *
 * Returns the array of message IDs (Telegram splits long newsletters into
 * multiple sendMessage calls).
 */
export type SendTelegramArgs = {
  chatId: string;
  chunks: string[];
};

export async function sendConfiguredTelegram(args: SendTelegramArgs): Promise<number[]> {
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  if (!settings?.telegramBotToken) {
    throw new Error('telegram settings incomplete (telegram_bot_token)');
  }
  const messageIds: number[] = [];
  for (const text of args.chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: args.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        }),
      },
    );
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
    } | null;
    if (!body?.ok) {
      throw new Error(`telegram send: ${body?.description ?? `http ${res.status}`}`);
    }
    if (body.result?.message_id != null) messageIds.push(body.result.message_id);
  }
  return messageIds;
}
