'use client';
import cronstrue from 'cronstrue';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

type Source = { url: string; hint?: string; needsBrowser?: boolean };

export type JobFormValues = {
  name: string;
  enabled: boolean;
  schedule: string;
  sources: Source[];
  topic: string;
  basePrompt: string;
  recipientEmail: string;
  outputFormat: 'markdown' | 'html' | 'json';
  maxItems: number;
  modelResearch: string;
  modelSummary: string;
  monthlyBudget: number;
  minIntervalMinutes: number | null;
};

const PRESETS: { label: string; value: string }[] = [
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Every 6h', value: '0 */6 * * *' },
  { label: 'Daily 08:00', value: '0 8 * * *' },
  { label: 'Weekly Mon 08:00', value: '0 8 * * 1' },
  { label: '1st of month 09:00', value: '0 9 1 * *' },
  { label: 'Custom', value: '' },
];

export function JobForm({
  initial,
  jobId,
  userEmail,
  defaults,
}: {
  initial: JobFormValues | null;
  jobId?: string;
  userEmail: string;
  defaults?: { modelResearch: string; modelSummary: string };
}) {
  const router = useRouter();
  const [v, setV] = useState<JobFormValues>(
    initial ?? {
      name: '',
      enabled: true,
      schedule: '0 8 * * *',
      sources: [{ url: '' }],
      topic: '',
      basePrompt: '',
      recipientEmail: userEmail,
      outputFormat: 'markdown',
      maxItems: 6,
      modelResearch: defaults?.modelResearch ?? 'claude-sonnet-4-6',
      modelSummary: defaults?.modelSummary ?? 'claude-haiku-4-5',
      monthlyBudget: 60,
      minIntervalMinutes: null,
    },
  );
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState(
    PRESETS.find((p) => p.value === (initial?.schedule ?? '0 8 * * *'))?.value ?? '',
  );

  const humanSchedule = useMemo(() => {
    try {
      return cronstrue.toString(v.schedule);
    } catch {
      return 'Invalid cron expression';
    }
  }, [v.schedule]);

  const [preview, setPreview] = useState<{
    next5: string[];
    collisions: { jobId: string; name: string }[];
  } | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ schedule: v.schedule });
        if (jobId) qs.set('excludeId', jobId);
        const res = await fetch(`/api/jobs/cron-preview?${qs}`);
        if (!res.ok) {
          setPreview(null);
          return;
        }
        const body = await res.json();
        setPreview({ next5: body.next5 ?? [], collisions: body.collisions ?? [] });
      } catch {
        setPreview(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [v.schedule, jobId]);

  function set<K extends keyof JobFormValues>(k: K, val: JobFormValues[K]) {
    setV((prev) => ({ ...prev, [k]: val }));
  }
  function setSource(i: number, patch: Partial<Source>) {
    setV((prev) => ({
      ...prev,
      sources: prev.sources.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    }));
  }
  function addSource() {
    setV((prev) => ({ ...prev, sources: [...prev.sources, { url: '' }] }));
  }
  function removeSource(i: number) {
    setV((prev) => ({ ...prev, sources: prev.sources.filter((_, idx) => idx !== i) }));
  }

  async function save(runAfter: boolean) {
    setBusy(true);
    setErr(null);
    setFieldErr({});
    const payload = {
      ...v,
      sources: v.sources.filter((s) => s.url.trim() !== ''),
    };
    const url = jobId ? `/api/jobs/${jobId}` : '/api/jobs';
    const method = jobId ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (body.field) setFieldErr({ [body.field]: body.error ?? 'invalid' });
      setErr(body.error ?? `save failed (${res.status})`);
      setBusy(false);
      return;
    }
    const saved = await res.json();
    if (runAfter) {
      await fetch(`/api/jobs/${saved.id}/run`, { method: 'POST' });
    }
    setBusy(false);
    router.push('/');
    router.refresh();
  }

  async function del() {
    if (!jobId) return;
    if (!confirm('Delete this job and all its runs?')) return;
    setBusy(true);
    const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) {
      setErr('delete failed');
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 720 }}
    >
      <label style={lbl}>
        Name
        <input style={inp} value={v.name} onChange={(e) => set('name', e.target.value)} required />
      </label>

      <label style={lbl}>
        Schedule preset
        <select
          style={inp}
          value={preset}
          onChange={(e) => {
            setPreset(e.target.value);
            if (e.target.value) set('schedule', e.target.value);
          }}
        >
          {PRESETS.map((p) => (
            <option key={p.label} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label style={lbl}>
        Cron expression
        <input
          style={inp}
          value={v.schedule}
          onChange={(e) => {
            set('schedule', e.target.value);
            setPreset('');
          }}
          required
        />
        <small style={{ color: fieldErr.schedule ? '#e66' : '#888' }}>
          {fieldErr.schedule ?? humanSchedule}
        </small>
        {preview && preview.next5.length > 0 && (
          <div
            style={{
              marginTop: 6,
              padding: '0.5rem 0.7rem',
              border: '1px solid #222',
              borderRadius: 3,
              background: '#0b0d13',
              fontSize: '0.85em',
            }}
          >
            <div style={{ color: '#9ab', marginBottom: 3 }}>Next 5 fires:</div>
            <ul style={{ margin: 0, paddingLeft: '1.1rem', color: '#ccc' }}>
              {preview.next5.map((t) => (
                <li key={t}>{new Date(t).toLocaleString()}</li>
              ))}
            </ul>
            {preview.collisions.length > 0 && (
              <div
                style={{
                  marginTop: 6,
                  color: '#f7d98a',
                  borderTop: '1px solid #222',
                  paddingTop: 5,
                }}
              >
                ⚠ Collides this minute with: {preview.collisions.map((c) => c.name).join(', ')}.
                Consider offsetting to <code>:03</code>, <code>:17</code>, or <code>:37</code> to
                stagger.
              </div>
            )}
          </div>
        )}
      </label>

      <fieldset style={fs}>
        <legend>Sources</legend>
        {v.sources.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: transient form rows
          <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <input
              style={{ ...inp, flex: 2 }}
              placeholder="https://…"
              value={s.url}
              onChange={(e) => setSource(i, { url: e.target.value })}
            />
            <input
              style={{ ...inp, flex: 1 }}
              placeholder="hint (optional)"
              value={s.hint ?? ''}
              onChange={(e) => setSource(i, { hint: e.target.value })}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#888' }}>
              <input
                type="checkbox"
                checked={s.needsBrowser ?? false}
                onChange={(e) => setSource(i, { needsBrowser: e.target.checked })}
              />
              browser
            </label>
            <button type="button" onClick={() => removeSource(i)} style={btnGhost}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={addSource} style={btnGhost}>
          + Add source
        </button>
      </fieldset>

      <label style={lbl}>
        Topic
        <input
          style={inp}
          value={v.topic}
          onChange={(e) => set('topic', e.target.value)}
          required
        />
      </label>

      <label style={lbl}>
        Base prompt <small style={{ color: '#888' }}>({v.basePrompt.length} chars)</small>
        <textarea
          style={{ ...inp, minHeight: 140, fontFamily: 'inherit' }}
          value={v.basePrompt}
          onChange={(e) => set('basePrompt', e.target.value)}
          placeholder={BASE_PROMPT_PLACEHOLDER}
          required
        />
        <BasePromptHints />
      </label>

      <label style={lbl}>
        Recipient email
        <input
          style={inp}
          type="email"
          value={v.recipientEmail}
          onChange={(e) => set('recipientEmail', e.target.value)}
          required
        />
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <label style={lbl}>
          Output format
          <select
            style={inp}
            value={v.outputFormat}
            onChange={(e) => set('outputFormat', e.target.value as JobFormValues['outputFormat'])}
          >
            <option value="markdown">markdown</option>
            <option value="html">html</option>
            <option value="json">json</option>
          </select>
        </label>
        <label style={lbl}>
          Max items
          <input
            style={inp}
            type="number"
            min={1}
            max={25}
            value={v.maxItems}
            onChange={(e) => set('maxItems', Number(e.target.value))}
          />
        </label>
        <label style={lbl}>
          Research model
          <input
            style={inp}
            value={v.modelResearch}
            onChange={(e) => set('modelResearch', e.target.value)}
          />
        </label>
        <label style={lbl}>
          Summary model
          <input
            style={inp}
            value={v.modelSummary}
            onChange={(e) => set('modelSummary', e.target.value)}
          />
        </label>
        <label style={lbl}>
          Monthly budget (runs)
          <input
            style={inp}
            type="number"
            min={1}
            value={v.monthlyBudget}
            onChange={(e) => set('monthlyBudget', Number(e.target.value))}
          />
        </label>
        <label style={lbl}>
          Min interval (minutes, optional)
          <input
            style={inp}
            type="number"
            min={0}
            value={v.minIntervalMinutes ?? ''}
            onChange={(e) =>
              set('minIntervalMinutes', e.target.value === '' ? null : Number(e.target.value))
            }
          />
        </label>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={v.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
        />
        Enabled
      </label>

      {err && <p style={{ color: '#e66', margin: 0 }}>{err}</p>}

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button type="submit" disabled={busy} style={btn}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={() => save(true)} style={btn}>
          Save & Run Now
        </button>
        {jobId && (
          <button
            type="button"
            disabled={busy}
            onClick={del}
            style={{ ...btnGhost, color: '#e66', borderColor: '#633', marginLeft: 'auto' }}
          >
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

const BASE_PROMPT_PLACEHOLDER =
  'e.g. A daily digest for my family about Turkish news. Categories: Son dakika, Siyaset, Spor, Ekonomi. All content in Turkish. Bodies around 80 words, 2-3 sentences. Always cite the source via link.';

function BasePromptHints() {
  return (
    <details style={{ marginTop: 4 }}>
      <summary style={{ cursor: 'pointer', color: '#9ab', fontSize: '0.85em' }}>
        Tips — what you can tell the summarizer
      </summary>
      <ul
        style={{
          margin: '0.4rem 0 0 1.1rem',
          padding: 0,
          color: '#888',
          fontSize: '0.85em',
          lineHeight: 1.6,
        }}
      >
        <li>
          <strong>Audience / tone</strong>: "for tech-savvy family members" · "casual, dry humor"
        </li>
        <li>
          <strong>Length per item</strong>: "bodies ~80 words, 2-3 sentences" · "short — one
          sentence each"
        </li>
        <li>
          <strong>Categories</strong>: "categories: Politics, Sports, Economy, Breaking" — each item
          is tagged and the newsletter groups by section
        </li>
        <li>
          <strong>Language</strong>: "all content in Turkish" · "write in plain English"
        </li>
        <li>
          <strong>Ordering</strong>: "most important first" · "breaking news at the top"
        </li>
        <li>
          <strong>Filters</strong>: "skip sports unless a Turkish athlete won something" · "only
          items directly about inflation or rates"
        </li>
        <li>
          <strong>Sources</strong>: "always include a source link" (already the default — state it
          only if you want emphasis)
        </li>
      </ul>
      <p style={{ margin: '0.4rem 0 0', color: '#888', fontSize: '0.85em' }}>
        The <code>Max items</code> field below is the hard cap — a budget on research cost. The
        prompt above controls everything else (length, tone, structure).
      </p>
    </details>
  );
}

const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const inp: React.CSSProperties = {
  background: '#0b0c0f',
  color: '#e6e6e6',
  border: '1px solid #333',
  padding: '0.5rem',
  borderRadius: 3,
  font: 'inherit',
};
const btn: React.CSSProperties = {
  background: '#2a6fdb',
  color: 'white',
  border: 0,
  padding: '0.6rem 1rem',
  borderRadius: 3,
  cursor: 'pointer',
};
const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: '#e6e6e6',
  border: '1px solid #444',
  padding: '0.4rem 0.8rem',
  borderRadius: 3,
  cursor: 'pointer',
};
const fs: React.CSSProperties = {
  border: '1px solid #222',
  borderRadius: 4,
  padding: '0.75rem',
};
