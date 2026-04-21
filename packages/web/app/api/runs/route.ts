import { errorResponse, requireUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const me = await requireUser();
    const url = new URL(req.url);
    const take = Math.min(Number(url.searchParams.get('take') ?? '50'), 200);
    const skip = Math.max(Number(url.searchParams.get('skip') ?? '0'), 0);

    const where = me.isAdmin ? {} : { job: { userId: me.id } };
    const [items, total] = await Promise.all([
      prisma.run.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          job: {
            select: { id: true, name: true, userId: true, user: { select: { email: true } } },
          },
        },
      }),
      prisma.run.count({ where }),
    ]);

    return Response.json({
      total,
      items: items.map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        startedAt: r.startedAt?.toISOString() ?? null,
        finishedAt: r.finishedAt?.toISOString() ?? null,
        error: r.error,
        skipResearch: r.skipResearch,
        job: {
          id: r.job.id,
          name: r.job.name,
          ownerEmail: r.job.user.email,
        },
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
