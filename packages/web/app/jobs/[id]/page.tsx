import { getCurrentUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { JobForm, type JobFormValues } from '../../_components/JobForm';
import { Topbar } from '../../_components/Topbar';

export const dynamic = 'force-dynamic';

export default async function EditJobPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect('/login');
  const { id } = await params;
  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      runs: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } },
    },
  });
  if (!job) notFound();
  if (job.userId !== me.id && !me.isAdmin) notFound();
  const latestRunId = job.runs[0]?.id ?? null;

  const initial: JobFormValues = {
    name: job.name,
    enabled: job.enabled,
    schedule: job.schedule,
    sources: (job.sources as unknown as JobFormValues['sources']) ?? [],
    topic: job.topic,
    basePrompt: job.basePrompt,
    recipientEmail: job.recipientEmail,
    outputFormat: job.outputFormat as JobFormValues['outputFormat'],
    maxItems: job.maxItems,
    modelResearch: job.modelResearch,
    modelSummary: job.modelSummary,
    monthlyBudget: job.monthlyBudget,
    minIntervalMinutes: job.minIntervalMinutes,
  };

  return (
    <>
      <Topbar email={me.email} isAdmin={me.isAdmin} />
      <main style={{ padding: '1.5rem' }}>
        <Link href="/" style={{ color: '#9ab' }}>
          ← Back
        </Link>
        {latestRunId && (
          <>
            {' · '}
            <Link href={`/runs/${latestRunId}`} style={{ color: '#9ab' }}>
              Latest run →
            </Link>
          </>
        )}
        <h1>{job.name}</h1>
        <JobForm initial={initial} jobId={job.id} userEmail={me.email} />
      </main>
    </>
  );
}
