'use client';
import { marked } from 'marked';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LocalTime } from '../../_components/LocalTime';
import { StopRunButton } from '../../_components/StopRunButton';
import { useToast } from '../../_components/Toaster';

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
  nextRunAt: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: string | null;
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
      if (['success', 'failed', 'deferred', 'cancelled'].includes(data.status)) {
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

  const toast = useToast();

  async function action(path: string, label: string) {
    setBusy(label);
    try {
      const res = await fetch(path, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { runId?: string; error?: string };
      if (!res.ok) {
        toast.error(`${label} failed: ${body.error ?? res.statusText}`);
      } else if (body.runId) {
        toast.success(`${label} queued`);
        setTimeout(() => {
          window.location.href = `/runs/${body.runId}`;
        }, 400);
      } else {
        toast.success(`${label} ok`);
      }
    } catch (e) {
      toast.error(`${label} error: ${e instanceof Error ? e.message : String(e)}`);
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
          Run {initial.id} · created <LocalTime iso={initial.createdAt} /> · duration {duration}
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
        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <StatusBadge status={status} />
          <StopRunButton runId={initial.id} status={status} />
        </div>
        {error && <ErrorDisplay message={error} nextRunAt={initial.nextRunAt} />}
        <UsageBadges
          tokensIn={initial.tokensIn}
          tokensOut={initial.tokensOut}
          costUsd={initial.costUsd}
        />
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
          disabled={!initial.renderedOutput || initial.job.outputFormat === 'json'}
          onClick={() =>
            printNewsletter(initial.renderedOutput, initial.job.outputFormat, initial.job.name)
          }
          style={btn}
          title="Open in a new window and launch the browser print dialog (choose 'Save as PDF')"
        >
          Print / Save as PDF
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
                <span style={{ color: '#666' }}>
                  <LocalTime iso={r.ts} mode="time" />{' '}
                </span>
                {r.message}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function printNewsletter(
  rendered: string | null,
  format: 'markdown' | 'html' | 'json',
  title: string,
) {
  if (!rendered || format === 'json') return;
  const body = format === 'html' ? rendered : (marked.parse(rendered, { async: false }) as string);
  const doc =
    format === 'html'
      ? body
      : `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#222}pre{white-space:pre-wrap}@media print{body{margin:0}}</style></head><body>${body}</body></html>`;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(doc);
  w.document.close();
  const trigger = () => {
    w.focus();
    w.print();
  };
  if (w.document.readyState === 'complete') {
    setTimeout(trigger, 100);
  } else {
    w.addEventListener('load', () => setTimeout(trigger, 100));
  }
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
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

function ErrorDisplay({ message, nextRunAt }: { message: string; nextRunAt: string | null }) {
  const match = classifyError(message);
  const wrap: React.CSSProperties = {
    background: '#2a1517',
    border: '1px solid #d04545',
    color: '#f7c6c6',
    padding: '0.75rem',
    marginTop: '0.75rem',
    borderRadius: 3,
    display: 'flex',
    gap: '0.6rem',
    alignItems: 'flex-start',
  };
  return (
    <div style={wrap}>
      <span style={{ fontSize: '1.3em', lineHeight: 1 }}>{match.icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{match.title}</div>
        <div style={{ fontSize: '0.9em', opacity: 0.9, marginBottom: 4 }}>
          {match.describe(message, nextRunAt)}
        </div>
        <details>
          <summary style={{ cursor: 'pointer', color: '#f7c6c6', opacity: 0.7 }}>raw error</summary>
          <pre style={{ whiteSpace: 'pre-wrap', margin: '0.4rem 0 0', fontSize: '0.85em' }}>
            {message}
          </pre>
        </details>
      </div>
    </div>
  );
}

function classifyError(msg: string): {
  icon: string;
  title: string;
  describe: (raw: string, nextRunAt: string | null) => React.ReactNode;
} {
  if (msg.startsWith('rate_limit:') || /rate[_\s-]?limit/i.test(msg)) {
    return {
      icon: '⏳',
      title: 'Claude rate limit hit',
      describe: (_r, next) =>
        next ? (
          <>
            Window resets at <LocalTime iso={next} />. Try Re-run after that time.
          </>
        ) : (
          'Window resets in ~5 hours. Try Re-run after that.'
        ),
    };
  }
  if (msg.startsWith('email send:')) {
    return {
      icon: '✉️',
      title: 'Email send failed',
      describe: () =>
        'SMTP rejected the message. Check /settings for a valid Gmail user + app password, then Resend.',
    };
  }
  if (msg.startsWith('stage2 validation failed')) {
    return {
      icon: '⚠️',
      title: 'Stage 2 output invalid',
      describe: () =>
        'The summary model produced JSON that failed length or schema checks after one retry. Re-run to try again — if it repeats, loosen Max items or tighten the base prompt.',
    };
  }
  return {
    icon: '✖',
    title: 'Run failed',
    describe: (raw) => raw,
  };
}

function UsageBadges({
  tokensIn,
  tokensOut,
  costUsd,
}: {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: string | null;
}) {
  if (tokensIn == null && tokensOut == null && costUsd == null) return null;
  const chip: React.CSSProperties = {
    border: '1px solid #333',
    borderRadius: 3,
    padding: '0.15rem 0.5rem',
    color: '#9ab',
    fontSize: '0.85em',
  };
  return (
    <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
      {tokensIn != null && <span style={chip}>in: {tokensIn.toLocaleString('en-US')}</span>}
      {tokensOut != null && <span style={chip}>out: {tokensOut.toLocaleString('en-US')}</span>}
      {costUsd != null && <span style={chip}>${Number(costUsd).toFixed(4)}</span>}
    </div>
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
