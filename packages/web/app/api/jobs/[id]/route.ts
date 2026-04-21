import { HttpError, errorResponse, requireUser } from '@/src/lib/session';
import { JobUpdate, nextFireAt, prisma, validateCron } from '@renews/shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

async function loadOwnedJob(id: string, userId: string, isAdmin: boolean) {
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) throw new HttpError(404, 'not found');
  if (job.userId !== userId && !isAdmin) throw new HttpError(404, 'not found');
  return job;
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const job = await loadOwnedJob(id, me.id, me.isAdmin);
    return Response.json(job);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;
    await loadOwnedJob(id, me.id, me.isAdmin);

    const body = await req.json().catch(() => null);
    const parsed = JobUpdate.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid input', {
        error: 'invalid input',
        issues: parsed.error.issues,
      });
    }
    if (parsed.data.schedule !== undefined) {
      const cronOk = validateCron(parsed.data.schedule);
      if (!cronOk.ok) {
        throw new HttpError(400, 'invalid cron', { error: 'invalid cron', field: 'schedule' });
      }
    }
    const data: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.schedule !== undefined) {
      data.nextRunAt = nextFireAt(parsed.data.schedule);
    }
    const updated = await prisma.job.update({ where: { id }, data });
    return Response.json(updated);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;
    await loadOwnedJob(id, me.id, me.isAdmin);
    await prisma.job.delete({ where: { id } });
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
