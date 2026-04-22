'use client';
import cronstrue from 'cronstrue';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LocalTime } from './LocalTime';
import { useToast } from './Toaster';

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

export function JobsTable({ jobs, showOwner }: { jobs: JobRow[]; showOwner: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(job: JobRow) {
    setBusy(job.id);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !job.enabled }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(`Could not change job: ${body.error ?? res.statusText}`);
      } else {
        toast.success(job.enabled ? 'Job disabled' : 'Job enabled');
      }
    } catch (e) {
      toast.error(`Could not change job: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  async function runNow(job: JobRow) {
    setBusy(job.id);
    try {
      const res = await fetch(`/api/jobs/${job.id}/run`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        runId?: string;
        status?: string;
        reason?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(`Could not enqueue: ${body.error ?? res.statusText}`);
      } else if (body.status === 'deferred') {
        toast.info(`Run deferred: ${body.reason ?? 'see run detail'}`);
      } else {
        toast.success('Run queued');
      }
    } catch (e) {
      toast.error(`Could not enqueue: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
      router.refresh();
    }
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
                  {j.lastRun.status} · <LocalTime iso={j.lastRun.createdAt} mode="relative" />
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
