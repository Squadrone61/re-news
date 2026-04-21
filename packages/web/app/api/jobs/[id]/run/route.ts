import { HttpError, errorResponse, requireUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) throw new HttpError(404, 'not found');
    if (job.userId !== me.id && !me.isAdmin) throw new HttpError(404, 'not found');

    const run = await prisma.run.create({
      data: { jobId: job.id, status: 'queued' },
      select: { id: true },
    });
    return Response.json({ runId: run.id });
  } catch (e) {
    return errorResponse(e);
  }
}
