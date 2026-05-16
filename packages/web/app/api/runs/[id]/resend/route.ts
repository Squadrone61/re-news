import { sendConfiguredMail, stripHtml } from '@/src/lib/mailer';
import { HttpError, errorResponse, requireUser } from '@/src/lib/session';
import { sendConfiguredTelegram } from '@/src/lib/telegram';
import { type StageTwo, prisma, renderTelegramHtml, streamLogToDb } from '@renews/shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const run = await prisma.run.findUnique({
      where: { id },
      include: { job: true },
    });
    if (!run) throw new HttpError(404, 'not found');
    if (!me.isAdmin && run.job.userId !== me.id) throw new HttpError(404, 'not found');
    if (!run.stage2Json) {
      throw new HttpError(409, 'run has no rendered output to resend');
    }

    const parsed = run.stage2Json as unknown as StageTwo;

    if (run.job.deliveryChannel === 'telegram') {
      if (!run.job.telegramChatId) {
        throw new HttpError(409, 'job is not linked to a Telegram chat');
      }
      const chunks = renderTelegramHtml(parsed);
      const messageIds = await sendConfiguredTelegram({
        chatId: run.job.telegramChatId,
        chunks,
      });
      await streamLogToDb(
        run.id,
        'sys',
        `resent by user ${me.email} → telegram ${run.job.telegramChatId} (${messageIds.length} msg, ids=${messageIds.join(',')})`,
      );
      return Response.json({ ok: true, messageIds });
    }

    if (!run.renderedOutput) {
      throw new HttpError(409, 'run has no rendered output to resend');
    }
    if (!run.job.recipientEmail) {
      throw new HttpError(409, 'job has no recipient email');
    }
    const isHtml = run.job.outputFormat === 'html';
    const messageId = await sendConfiguredMail({
      to: run.job.recipientEmail,
      subject: parsed.subject,
      text: isHtml ? stripHtml(run.renderedOutput) : run.renderedOutput,
      html: isHtml ? run.renderedOutput : undefined,
    });

    await streamLogToDb(
      run.id,
      'sys',
      `resent by user ${me.email} → ${run.job.recipientEmail} (messageId=${messageId})`,
    );
    return Response.json({ ok: true, messageId });
  } catch (e) {
    return errorResponse(e);
  }
}
