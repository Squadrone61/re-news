'use client';
import { marked } from 'marked';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

type Initial = {
  id: string;
  status: string;
  skipResearch: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  researchRaw: unknown;
  renderedOutput: string | null;
  stage2Json: unknown;
  job: {
    id: string;
    name: string;
    outputFormat: 'markdown' | 'html' | 'json';
    recipientEmail: string;
  };
};

type LogRow = {
  id: string;
  ts: string;
  level: string;
  stage: string;
  message: string;
};

const STAGES = ['research', 'summary', 'email', 'sys'] as const;
type Stage = (typeof STAGES)[number];

export function RunDetail({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial.status);
  const [error, setError] = useState<string | null>(initial.error);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runId-scoped effect
  useEffect(() => {
    const es = new EventSource(`/api/runs/${initial.id}/logs/stream`);
    es.addEventListener('log', (ev) => {
      const row = JSON.parse((ev as MessageEvent).data) as LogRow;
      setLogs((prev) => [...prev, row]);
    });
    es.addEventListener('status', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as {
        status: string;
        error?: string | null;
      };
      setStatus(data.status);
      if (data.error !== undefined) setError(data.error ?? null);
      if (['success', 'failed', 'deferred'].includes(data.status)) {
        // refresh server data (researchRaw / rendered / stage2Json) on terminal status
        router.refresh();
      }
    });
    es.addEventListener('error', () => {
      /* browser auto-reconnects */
    });
    return () => es.close();
  }, [initial.id]);

  const grouped = useMemo(() => {
    const m: Record<Stage, LogRow[]> = { research: [], summary: [], email: [], sys: [] };
    for (const row of logs) {
      const st = (STAGES as readonly string[]).includes(row.stage) ? (row.stage as Stage) : 'sys';
      m[st].push(row);
    }
    return m;
  }, [logs]);

  async function action(path: string, label: string) {
    setBusy(label);
    setNotice(null);
    try {
      const res = await fetch(path, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { runId?: string; error?: string };
      if (!res.ok) {
        setNotice(`${label} failed: ${body.error ?? res.statusText}`);
      } else if (body.runId) {
        setNotice(`${label} queued → new run ${body.runId.slice(0, 8)}…`);
        setTimeout(() => {
          window.location.href = `/runs/${body.runId}`;
        }, 400);
      } else {
        setNotice(`${label} ok`);
      }
    } catch (e) {
      setNotice(`${label} error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const duration =
    initial.startedAt && initial.finishedAt
      ? `${Math.round((new Date(initial.finishedAt).getTime() - new Date(initial.startedAt).getTime()) / 1000)}s`
      : initial.startedAt
        ? 'running…'
        : '—';

  return (
    <div>
      <header style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: '0 0 0.3rem' }}>{initial.job.name}</h1>
        <div style={{ color: '#888', fontSize: '0.9em' }}>
          Run {initial.id} · created {new Date(initial.createdAt).toLocaleString()} · duration{' '}
          {duration}
          {initial.skipResearch && (
            <span
              style={{
                marginLeft: '0.5rem',
                border: '1px solid #444',
                padding: '0.05rem 0.4rem',
                borderRadius: 3,
                color: '#9ab',
              }}
            >
              stage2-only
            </span>
          )}
        </div>
        <div style={{ marginTop: '0.5rem' }}>
          <StatusBadge status={status} />
        </div>
        {error && (
          <pre
            style={{
              background: '#2a1517',
              border: '1px solid #d04545',
              color: '#f7c6c6',
              padding: '0.75rem',
              marginTop: '0.75rem',
              whiteSpace: 'pre-wrap',
              borderRadius: 3,
            }}
          >
            {error}
          </pre>
        )}
      </header>

      <section style={{ margin: '1rem 0', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={busy !== null || !initial.renderedOutput}
          onClick={() => action(`/api/runs/${initial.id}/resend`, 'Resend')}
          style={btn}
        >
          {busy === 'Resend' ? 'Resending…' : 'Resend email'}
        </button>
        <button
          type="button"
          disabled={busy !== null || !initial.researchRaw}
          onClick={() => action(`/api/runs/${initial.id}/rerun-stage2`, 'Re-run Stage 2')}
          style={btn}
          title={
            initial.researchRaw
              ? 'Reuse research JSON and re-run summary/render/email'
              : 'No research JSON on this run'
          }
        >
          {busy === 'Re-run Stage 2' ? 'Queuing…' : 'Re-run Stage 2'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => action(`/api/runs/${initial.id}/rerun-full`, 'Re-run full')}
          style={btn}
        >
          {busy === 'Re-run full' ? 'Queuing…' : 'Re-run full'}
        </button>
        {notice && <span style={{ marginLeft: '0.5rem', color: '#9ab' }}>{notice}</span>}
      </section>

      <h2 style={h2}>Logs</h2>
      <div style={{ border: '1px solid #333', borderRadius: 3 }}>
        {STAGES.map((st) => (
          <StageLogs key={st} stage={st} rows={grouped[st]} />
        ))}
      </div>

      <h2 style={h2}>Preview</h2>
      <Preview rendered={initial.renderedOutput} format={initial.job.outputFormat} />

      <details style={{ marginTop: '1rem' }}>
        <summary style={{ cursor: 'pointer', color: '#9ab' }}>Raw research JSON</summary>
        <pre style={preBlock}>
          {initial.researchRaw ? JSON.stringify(initial.researchRaw, null, 2) : '(none)'}
        </pre>
      </details>

      <details style={{ marginTop: '0.5rem' }}>
        <summary style={{ cursor: 'pointer', color: '#9ab' }}>Stage 2 JSON</summary>
        <pre style={preBlock}>
          {initial.stage2Json ? JSON.stringify(initial.stage2Json, null, 2) : '(none)'}
        </pre>
      </details>
    </div>
  );
}

function StageLogs({ stage, rows }: { stage: Stage; rows: LogRow[] }) {
  const [open, setOpen] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when new log rows arrive
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows.length, open]);

  const onScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div style={{ borderTop: '1px solid #222' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          textAlign: 'left',
          background: '#111319',
          color: '#e6e6e6',
          border: 0,
          padding: '0.5rem 0.75rem',
          cursor: 'pointer',
        }}
      >
        {open ? '▾' : '▸'} {stage} · {rows.length}
      </button>
      {open && (
        <div
          ref={bodyRef}
          onScroll={onScroll}
          style={{
            maxHeight: '300px',
            overflow: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '0.85em',
            padding: '0.5rem 0.75rem',
            background: '#0b0d13',
          }}
        >
          {rows.length === 0 ? (
            <div style={{ color: '#555' }}>(no logs)</div>
          ) : (
            rows.map((r) => (
              <div
                key={r.id}
                style={{
                  color: r.level === 'error' ? '#f7a0a0' : r.level === 'warn' ? '#f7d98a' : '#ddd',
                  whiteSpace: 'pre-wrap',
                  marginBottom: '0.15rem',
                }}
              >
                <span style={{ color: '#666' }}>{new Date(r.ts).toLocaleTimeString()} </span>
                {r.message}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Preview({
  rendered,
  format,
}: {
  rendered: string | null;
  format: 'markdown' | 'html' | 'json';
}) {
  if (!rendered) {
    return <p style={{ color: '#666' }}>(no rendered output yet)</p>;
  }
  if (format === 'html') {
    return (
      <iframe
        title="newsletter preview"
        srcDoc={rendered}
        sandbox=""
        style={{
          width: '100%',
          height: '60vh',
          border: '1px solid #333',
          background: 'white',
          borderRadius: 3,
        }}
      />
    );
  }
  if (format === 'markdown') {
    const html = marked.parse(rendered, { async: false }) as string;
    return (
      <div
        style={{
          border: '1px solid #333',
          background: '#f7f7f7',
          color: '#222',
          padding: '1rem',
          borderRadius: 3,
          maxHeight: '60vh',
          overflow: 'auto',
        }}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown rendered server-side trusted content
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <pre style={preBlock}>{rendered}</pre>;
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
            : '#777';
  return (
    <span
      style={{
        background: color,
        color: 'white',
        padding: '0.2rem 0.6rem',
        borderRadius: 3,
        fontSize: '0.9em',
      }}
    >
      {status}
    </span>
  );
}

const btn: React.CSSProperties = {
  background: 'transparent',
  color: '#e6e6e6',
  border: '1px solid #444',
  padding: '0.4rem 0.8rem',
  cursor: 'pointer',
  borderRadius: 3,
};
const h2: React.CSSProperties = { margin: '1.5rem 0 0.5rem', fontSize: '1.1em' };
const preBlock: React.CSSProperties = {
  background: '#0b0d13',
  border: '1px solid #222',
  color: '#ddd',
  padding: '0.75rem',
  borderRadius: 3,
  overflow: 'auto',
  maxHeight: '60vh',
  fontSize: '0.85em',
  whiteSpace: 'pre-wrap',
};
