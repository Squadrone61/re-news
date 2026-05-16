import { randomBytes } from 'node:crypto';
import { HttpError, errorResponse, requireUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const TOKEN_LIFETIME_MS = 10 * 60_000;

const Body = z.object({ kind: z.enum(['dm', 'group']) });

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) throw new HttpError(404, 'not found');
    if (job.userId !== me.id && !me.isAdmin) throw new HttpError(404, 'not found');

    const body = await req.json().catch(() => null);
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid kind', { error: 'invalid kind (dm|group)' });
    }

    const settings = await prisma.setting.findUnique({
      where: { id: 1 },
      select: { telegramBotToken: true, telegramBotUsername: true },
    });
    if (!settings?.telegramBotToken) {
      throw new HttpError(400, 'telegram bot token not configured', {
        error: 'Set the Telegram bot token in Settings first.',
      });
    }
    if (parsed.data.kind === 'dm' && !settings.telegramBotUsername) {
      throw new HttpError(400, 'bot username not cached yet', {
        error: 'Bot username not validated yet. Wait ~60s after setting the token, then retry.',
      });
    }

    const token = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
    await prisma.jobLinkToken.create({
      data: { token, jobId: id, kind: parsed.data.kind, expiresAt },
    });

    const deepLink =
      parsed.data.kind === 'dm'
        ? `https://t.me/${settings.telegramBotUsername}?start=${token}`
        : null;

    return Response.json({ token, deepLink, kind: parsed.data.kind, expiresAt });
  } catch (e) {
    return errorResponse(e);
  }
}
