import { getCurrentUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Topbar } from '../_components/Topbar';
import { SettingsForm } from './SettingsForm';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const me = await getCurrentUser();
  if (!me) redirect('/login');
  if (!me.isAdmin) redirect('/');

  const row = await prisma.setting.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });

  return (
    <>
      <Topbar email={me.email} isAdmin={me.isAdmin} />
      <main style={{ padding: '1.5rem', maxWidth: 720 }}>
        <Link href="/" style={{ color: '#9ab' }}>
          ← Back
        </Link>
        <h1>Settings</h1>
        <p style={{ color: '#888' }}>
          Shared sender + default models. Applies to all users' newsletters.
        </p>
        <SettingsForm
          initial={{
            gmailUser: row.gmailUser ?? '',
            gmailAppPasswordSet: !!row.gmailAppPassword,
            senderName: row.senderName ?? '',
            defaultModelResearch: row.defaultModelResearch,
            defaultModelSummary: row.defaultModelSummary,
            workerConcurrency: row.workerConcurrency,
          }}
        />
      </main>
    </>
  );
}
