import { getCurrentUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { JobForm } from '../../_components/JobForm';
import { Topbar } from '../../_components/Topbar';

export const dynamic = 'force-dynamic';

export default async function NewJobPage() {
  const me = await getCurrentUser();
  if (!me) redirect('/login');
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  return (
    <>
      <Topbar email={me.email} isAdmin={me.isAdmin} />
      <main style={{ padding: '1.5rem' }}>
        <Link href="/" style={{ color: '#9ab' }}>
          ← Back
        </Link>
        <h1>New job</h1>
        <JobForm
          initial={null}
          userEmail={me.email}
          defaults={{
            modelResearch: settings?.defaultModelResearch ?? 'claude-sonnet-4-6',
            modelSummary: settings?.defaultModelSummary ?? 'claude-haiku-4-5',
          }}
        />
      </main>
    </>
  );
}
