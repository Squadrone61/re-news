import { HttpError, errorResponse, requireUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const job = await prisma.job.findUnique({
      where: { id },
      select: {
        userId: true,
        telegramChatId: true,
        telegramChatType: true,
        telegramChatTitle: true,
      },
    });
    if (!job) throw new HttpError(404, 'not found');
    if (job.userId !== me.id && !me.isAdmin) throw new HttpError(404, 'not found');

    return Response.json({
      linked: !!job.telegramChatId,
      chatId: job.telegramChatId,
      chatType: job.telegramChatType,
      chatTitle: job.telegramChatTitle,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
