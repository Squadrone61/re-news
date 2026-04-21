import { HttpError, errorResponse, requireUser } from '@/src/lib/session';
import { JobInput, nextFireAt, prisma, validateCron } from '@renews/shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await requireUser();
    const where = me.isAdmin ? {} : { userId: me.id };
    const jobs = await prisma.job.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, createdAt: true, finishedAt: true },
        },
      },
    });
    return Response.json(jobs);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = JobInput.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid input', {
        error: 'invalid input',
        issues: parsed.error.issues,
      });
    }
    const cronOk = validateCron(parsed.data.schedule);
    if (!cronOk.ok) {
      throw new HttpError(400, 'invalid cron', { error: 'invalid cron', field: 'schedule' });
    }
    const job = await prisma.job.create({
      data: {
        userId: me.id,
        name: parsed.data.name,
        enabled: parsed.data.enabled,
        schedule: parsed.data.schedule,
        sources: parsed.data.sources,
        topic: parsed.data.topic,
        basePrompt: parsed.data.basePrompt,
        recipientEmail: parsed.data.recipientEmail,
        outputFormat: parsed.data.outputFormat,
        maxItems: parsed.data.maxItems,
        modelResearch: parsed.data.modelResearch,
        modelSummary: parsed.data.modelSummary,
        monthlyBudget: parsed.data.monthlyBudget,
        minIntervalMinutes: parsed.data.minIntervalMinutes ?? null,
        nextRunAt: nextFireAt(parsed.data.schedule),
      },
    });
    return Response.json(job, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
