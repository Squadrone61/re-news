import { errorResponse, requireUser } from '@/src/lib/session';
import { nextFireAt, prisma, validateCron } from '@renews/shared';
import { CronExpressionParser } from 'cron-parser';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  try {
    const me = await requireUser();
    const url = new URL(req.url);
    const schedule = url.searchParams.get('schedule') ?? '';
    const excludeId = url.searchParams.get('excludeId') ?? undefined;

    const ok = validateCron(schedule);
    if (!ok.ok) {
      return Response.json({ error: ok.error, next5: [], collisions: [] }, { status: 400 });
    }

    const it = CronExpressionParser.parse(schedule, { currentDate: new Date() });
    const next5: string[] = [];
    for (let i = 0; i < 5; i++) next5.push(it.next().toDate().toISOString());

    const first = new Date(next5[0]!);
    const firstMinute = `${first.getUTCFullYear()}-${first.getUTCMonth()}-${first.getUTCDate()}T${first.getUTCHours()}:${first.getUTCMinutes()}`;
    const sixtyMinFromNow = new Date(Date.now() + 60 * 60 * 1000);

    const candidateJobs = await prisma.job.findMany({
      where: {
        enabled: true,
        userId: me.isAdmin ? undefined : me.id,
        id: excludeId ? { not: excludeId } : undefined,
      },
      select: { id: true, name: true, schedule: true, userId: true },
    });

    const collisions: Array<{ jobId: string; name: string }> = [];
    for (const j of candidateJobs) {
      const n = nextFireAt(j.schedule);
      if (!n) continue;
      if (n > sixtyMinFromNow) continue;
      const key = `${n.getUTCFullYear()}-${n.getUTCMonth()}-${n.getUTCDate()}T${n.getUTCHours()}:${n.getUTCMinutes()}`;
      if (key === firstMinute) collisions.push({ jobId: j.id, name: j.name });
    }

    return Response.json({ next5, collisions });
  } catch (e) {
    return errorResponse(e);
  }
}
