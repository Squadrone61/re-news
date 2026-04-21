import { getCurrentUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const POLL_MS = 1000;

export async function GET(req: Request, { params }: Ctx) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  const run = await prisma.run.findUnique({
    where: { id },
    select: { id: true, status: true, job: { select: { userId: true } } },
  });
  if (!run) return Response.json({ error: 'not found' }, { status: 404 });
  if (!me.isAdmin && run.job.userId !== me.id) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let lastSeenId = 0n;
      let lastStatus: string = run.status;
      let closed = false;

      const write = (event: string, data: unknown) => {
        if (closed) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener('abort', close);

      write('status', { status: lastStatus });

      // initial flush
      const initial = await prisma.runLog.findMany({
        where: { runId: id },
        orderBy: { id: 'asc' },
        select: { id: true, ts: true, level: true, stage: true, message: true },
      });
      for (const row of initial) {
        write('log', {
          id: row.id.toString(),
          ts: row.ts.toISOString(),
          level: row.level,
          stage: row.stage,
          message: row.message,
        });
        if (row.id > lastSeenId) lastSeenId = row.id;
      }

      const tick = async () => {
        if (closed) return;
        try {
          const rows = await prisma.runLog.findMany({
            where: { runId: id, id: { gt: lastSeenId } },
            orderBy: { id: 'asc' },
            select: { id: true, ts: true, level: true, stage: true, message: true },
          });
          for (const row of rows) {
            write('log', {
              id: row.id.toString(),
              ts: row.ts.toISOString(),
              level: row.level,
              stage: row.stage,
              message: row.message,
            });
            if (row.id > lastSeenId) lastSeenId = row.id;
          }
          const current = await prisma.run.findUnique({
            where: { id },
            select: { status: true, finishedAt: true, error: true },
          });
          if (current && current.status !== lastStatus) {
            lastStatus = current.status;
            write('status', {
              status: current.status,
              finishedAt: current.finishedAt?.toISOString() ?? null,
              error: current.error,
            });
          }
        } catch (err) {
          write('error', { message: err instanceof Error ? err.message : String(err) });
        }
      };

      const interval = setInterval(tick, POLL_MS);
      req.signal.addEventListener('abort', () => clearInterval(interval));
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
