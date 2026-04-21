import { getCurrentUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { JobsTable } from './_components/JobsTable';
import { Topbar } from './_components/Topbar';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const me = await getCurrentUser();
  if (!me) {
    const total = await prisma.user.count();
    if (total === 0) redirect('/setup');
    redirect('/login');
  }
  const jobs = await prisma.job.findMany({
    where: me.isAdmin ? {} : { userId: me.id },
    orderBy: { createdAt: 'desc' },
    include: {
      runs: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, status: true, createdAt: true },
      },
      user: { select: { email: true } },
    },
  });
  return (
    <>
      <Topbar email={me.email} isAdmin={me.isAdmin} />
      <main style={{ padding: '1.5rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '1rem',
          }}
        >
          <h1 style={{ margin: 0 }}>Jobs</h1>
          <Link
            href="/jobs/new"
            style={{
              background: '#2a6fdb',
              color: 'white',
              padding: '0.5rem 0.9rem',
              textDecoration: 'none',
              borderRadius: 4,
            }}
          >
            New job
          </Link>
        </div>
        <JobsTable
          jobs={jobs.map((j) => ({
            id: j.id,
            name: j.name,
            schedule: j.schedule,
            enabled: j.enabled,
            ownerEmail: j.user.email,
            lastRun: j.runs[0]
              ? {
                  id: j.runs[0].id,
                  status: j.runs[0].status,
                  createdAt: j.runs[0].createdAt.toISOString(),
                }
              : null,
          }))}
          showOwner={me.isAdmin}
        />
      </main>
    </>
  );
}
