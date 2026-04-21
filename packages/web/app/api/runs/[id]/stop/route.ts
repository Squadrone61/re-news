import { HttpError, errorResponse, requireUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;

    const run = await prisma.run.findUnique({
      where: { id },
      select: { id: true, status: true, job: { select: { userId: true } } },
    });
    if (!run) throw new HttpError(404, 'not found');
    if (!me.isAdmin && run.job.userId !== me.id) throw new HttpError(404, 'not found');

    if (run.status === 'queued') {
      const claimed = await prisma.run.updateMany({
        where: { id, status: 'queued' },
        data: {
          status: 'cancelled',
          finishedAt: new Date(),
          cancelRequested: false,
          error: 'cancelled by user',
        },
      });
      if (claimed.count === 1) {
        return Response.json({ status: 'cancelled' });
      }
      // race: worker just claimed it — fall through to the running path
    }

    if (run.status === 'queued' || run.status === 'running') {
      await prisma.run.update({
        where: { id },
        data: { cancelRequested: true },
      });
      return Response.json({ status: 'stopping' });
    }

    throw new HttpError(409, 'run is not stoppable');
  } catch (e) {
    return errorResponse(e);
  }
}
