import { getCurrentUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Topbar } from '../_components/Topbar';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function RunsListPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const me = await getCurrentUser();
  if (!me) redirect('/login');

  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? '1') || 1);
  const skip = (page - 1) * PAGE_SIZE;

  const where = me.isAdmin ? {} : { job: { userId: me.id } };
  const [runs, total] = await Promise.all([
    prisma.run.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
      skip,
      include: {
        job: { select: { id: true, name: true, user: { select: { email: true } } } },
      },
    }),
    prisma.run.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <Topbar email={me.email} isAdmin={me.isAdmin} />
      <main style={{ padding: '1.5rem' }}>
        <h1 style={{ marginTop: 0 }}>Runs</h1>
        {runs.length === 0 ? (
          <p style={{ color: '#888' }}>No runs yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#888' }}>
                <th style={th}>When</th>
                <th style={th}>Job</th>
                {me.isAdmin && <th style={th}>Owner</th>}
                <th style={th}>Status</th>
                <th style={th}>Duration</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const dur =
                  r.startedAt && r.finishedAt
                    ? `${Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000)}s`
                    : '—';
                return (
                  <tr key={r.id} style={{ borderTop: '1px solid #222' }}>
                    <td style={td}>{r.createdAt.toLocaleString()}</td>
                    <td style={td}>
                      <Link href={`/jobs/${r.job.id}`} style={{ color: '#e6e6e6' }}>
                        {r.job.name}
                      </Link>
                      {r.skipResearch && <span style={tagS}>stage2</span>}
                    </td>
                    {me.isAdmin && <td style={td}>{r.job.user.email}</td>}
                    <td style={td}>
                      <StatusBadge status={r.status} />
                    </td>
                    <td style={td}>{dur}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <Link href={`/runs/${r.id}`} style={btn}>
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {page > 1 && (
            <Link href={`/runs?page=${page - 1}`} style={btn}>
              ← Prev
            </Link>
          )}
          <span style={{ color: '#888' }}>
            Page {page} / {totalPages} · {total} runs
          </span>
          {page < totalPages && (
            <Link href={`/runs?page=${page + 1}`} style={btn}>
              Next →
            </Link>
          )}
        </div>
      </main>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'success'
      ? '#2a9d4f'
      : status === 'failed'
        ? '#d04545'
        : status === 'running'
          ? '#2a6fdb'
          : status === 'deferred'
            ? '#c08a2e'
            : status === 'cancelled'
              ? '#888'
              : '#777';
  return (
    <span
      style={{
        background: color,
        color: 'white',
        padding: '0.15rem 0.5rem',
        borderRadius: 3,
        fontSize: '0.85em',
      }}
    >
      {status}
    </span>
  );
}

const th: React.CSSProperties = { padding: '0.5rem 0.75rem', fontWeight: 500 };
const td: React.CSSProperties = { padding: '0.6rem 0.75rem' };
const btn: React.CSSProperties = {
  background: 'transparent',
  color: '#e6e6e6',
  border: '1px solid #444',
  padding: '0.3rem 0.7rem',
  cursor: 'pointer',
  textDecoration: 'none',
  borderRadius: 3,
  display: 'inline-block',
};
const tagS: React.CSSProperties = {
  marginLeft: '0.5rem',
  background: '#222',
  border: '1px solid #444',
  color: '#9ab',
  padding: '0.05rem 0.4rem',
  borderRadius: 3,
  fontSize: '0.75em',
};
