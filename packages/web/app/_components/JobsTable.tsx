'use client';
import cronstrue from 'cronstrue';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type JobRow = {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  ownerEmail: string;
  lastRun: { id: string; status: string; createdAt: string } | null;
};

function humanCron(expr: string) {
  try {
    return cronstrue.toString(expr);
  } catch {
    return expr;
  }
}

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function JobsTable({ jobs, showOwner }: { jobs: JobRow[]; showOwner: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(job: JobRow) {
    setBusy(job.id);
    await fetch(`/api/jobs/${job.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !job.enabled }),
    });
    setBusy(null);
    router.refresh();
  }

  async function runNow(job: JobRow) {
    setBusy(job.id);
    await fetch(`/api/jobs/${job.id}/run`, { method: 'POST' });
    setBusy(null);
    router.refresh();
  }

  if (jobs.length === 0) {
    return <p style={{ color: '#888' }}>No jobs yet. Create one to get started.</p>;
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ textAlign: 'left', color: '#888' }}>
          <th style={th}>Name</th>
          <th style={th}>Schedule</th>
          {showOwner && <th style={th}>Owner</th>}
          <th style={th}>Last run</th>
          <th style={th}>Enabled</th>
          <th style={th} />
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id} style={{ borderTop: '1px solid #222' }}>
            <td style={td}>
              <Link href={`/jobs/${j.id}`} style={{ color: '#e6e6e6' }}>
                {j.name}
              </Link>
            </td>
            <td style={td}>{humanCron(j.schedule)}</td>
            {showOwner && <td style={td}>{j.ownerEmail}</td>}
            <td style={td}>
              {j.lastRun ? (
                <Link href={`/runs/${j.lastRun.id}`} style={{ color: '#e6e6e6' }}>
                  {j.lastRun.status} · {relTime(j.lastRun.createdAt)}
                </Link>
              ) : (
                '—'
              )}
            </td>
            <td style={td}>
              <input
                type="checkbox"
                checked={j.enabled}
                onChange={() => toggle(j)}
                disabled={busy === j.id}
              />
            </td>
            <td style={{ ...td, textAlign: 'right' }}>
              <button type="button" onClick={() => runNow(j)} disabled={busy === j.id} style={btn}>
                Run now
              </button>{' '}
              <Link href={`/jobs/${j.id}`} style={{ ...btn, display: 'inline-block' }}>
                Edit
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
};
