import { getCurrentUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Topbar } from '../../_components/Topbar';
import { UsersManager } from './UsersManager';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const me = await getCurrentUser();
  if (!me) redirect('/login');
  if (!me.isAdmin) redirect('/');
  const users = await prisma.user.findMany({
    select: { id: true, email: true, isAdmin: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  return (
    <>
      <Topbar email={me.email} isAdmin={me.isAdmin} />
      <main style={{ padding: '1.5rem' }}>
        <Link href="/" style={{ color: '#9ab' }}>
          ← Back
        </Link>
        <h1>Users</h1>
        <UsersManager
          meId={me.id}
          initial={users.map((u) => ({
            id: u.id,
            email: u.email,
            isAdmin: u.isAdmin,
            createdAt: u.createdAt.toISOString(),
          }))}
        />
      </main>
    </>
  );
}
