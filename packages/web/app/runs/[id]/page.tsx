import { getCurrentUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Topbar } from '../../_components/Topbar';
import { RunDetail } from './RunDetail';

export const dynamic = 'force-dynamic';

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect('/login');
  const { id } = await params;
  const run = await prisma.run.findUnique({
    where: { id },
    include: { job: true },
  });
  if (!run) notFound();
  if (!me.isAdmin && run.job.userId !== me.id) notFound();

  const initial = {
    id: run.id,
    status: run.status,
    skipResearch: run.skipResearch,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    error: run.error,
    researchRaw: run.researchRaw,
    renderedOutput: run.renderedOutput,
    stage2Json: run.stage2Json,
    nextRunAt: run.nextRunAt?.toISOString() ?? null,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    costUsd: run.costUsd ? run.costUsd.toString() : null,
    job: {
      id: run.job.id,
      name: run.job.name,
      outputFormat: run.job.outputFormat as 'markdown' | 'html' | 'json',
      recipientEmail: run.job.recipientEmail,
    },
  };

  return (
    <>
      <Topbar email={me.email} isAdmin={me.isAdmin} />
      <main style={{ padding: '1.5rem' }}>
        <div style={{ marginBottom: '1rem' }}>
          <Link href="/runs" style={{ color: '#9ab' }}>
            ← All runs
          </Link>
          {' · '}
          <Link href={`/jobs/${run.job.id}`} style={{ color: '#9ab' }}>
            Edit job
          </Link>
        </div>
        <RunDetail initial={initial} />
      </main>
    </>
  );
}
