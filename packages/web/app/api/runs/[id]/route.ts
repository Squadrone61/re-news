import { HttpError, errorResponse, requireUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const run = await prisma.run.findUnique({
      where: { id },
      include: { job: true },
    });
    if (!run) throw new HttpError(404, 'not found');
    if (!me.isAdmin && run.job.userId !== me.id) throw new HttpError(404, 'not found');
    return Response.json({
      id: run.id,
      status: run.status,
      attempt: run.attempt,
      skipResearch: run.skipResearch,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      heartbeatAt: run.heartbeatAt?.toISOString() ?? null,
      error: run.error,
      researchRaw: run.researchRaw,
      stage2Json: run.stage2Json,
      renderedOutput: run.renderedOutput,
      job: {
        id: run.job.id,
        name: run.job.name,
        outputFormat: run.job.outputFormat,
        recipientEmail: run.job.recipientEmail,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
