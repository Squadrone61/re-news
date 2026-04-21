import { getCurrentUser } from '@/src/lib/session';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { JobForm } from '../../_components/JobForm';
import { Topbar } from '../../_components/Topbar';

export const dynamic = 'force-dynamic';

export default async function NewJobPage() {
  const me = await getCurrentUser();
  if (!me) redirect('/login');
  return (
    <>
      <Topbar email={me.email} isAdmin={me.isAdmin} />
      <main style={{ padding: '1.5rem' }}>
        <Link href="/" style={{ color: '#9ab' }}>
          ← Back
        </Link>
        <h1>New job</h1>
        <JobForm initial={null} userEmail={me.email} />
      </main>
    </>
  );
}
