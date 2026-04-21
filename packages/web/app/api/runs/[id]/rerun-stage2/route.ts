import { HttpError, errorResponse, requireUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const existing = await prisma.run.findUnique({
      where: { id },
      select: {
        jobId: true,
        researchRaw: true,
        job: { select: { userId: true } },
      },
    });
    if (!existing) throw new HttpError(404, 'not found');
    if (!me.isAdmin && existing.job.userId !== me.id) throw new HttpError(404, 'not found');
    if (!existing.researchRaw) {
      throw new HttpError(409, 'researchRaw not available on this run');
    }

    const run = await prisma.run.create({
      data: {
        jobId: existing.jobId,
        status: 'queued',
        researchRaw: existing.researchRaw as object,
        skipResearch: true,
      },
      select: { id: true },
    });
    return Response.json({ runId: run.id });
  } catch (e) {
    return errorResponse(e);
  }
}
