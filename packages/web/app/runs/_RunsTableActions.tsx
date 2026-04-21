'use client';
import Link from 'next/link';
import { StopRunButton } from '../_components/StopRunButton';

export function RunsTableActions({ runId, status }: { runId: string; status: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
      <StopRunButton runId={runId} status={status} />
      <Link
        href={`/runs/${runId}`}
        style={{
          background: 'transparent',
          color: '#e6e6e6',
          border: '1px solid #444',
          padding: '0.3rem 0.7rem',
          cursor: 'pointer',
          textDecoration: 'none',
          borderRadius: 3,
          display: 'inline-block',
        }}
      >
        Open
      </Link>
    </span>
  );
}
