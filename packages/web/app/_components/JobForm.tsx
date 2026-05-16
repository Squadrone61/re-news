'use client';
import cronstrue from 'cronstrue';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useToast } from './Toaster';

type SourceUrl = { kind: 'url'; url: string; hint?: string; needsBrowser?: boolean };
type SourceSearch = { kind: 'search'; search: string; hint?: string };
type Source = SourceUrl | SourceSearch;

function hydrateSource(s: unknown): Source {
  if (s && typeof s === 'object') {
    const o = s as Record<string, unknown>;
    if (typeof o.search === 'string') {
      return {
        kind: 'search',
        search: o.search,
        hint: typeof o.hint === 'string' ? o.hint : undefined,
      };
    }
    return {
      kind: 'url',
      url: typeof o.url === 'string' ? o.url : '',
      hint: typeof o.hint === 'string' ? o.hint : undefined,
      needsBrowser: o.needsBrowser === true,
    };
  }
  return { kind: 'url', url: '' };
}

export type JobFormValues = {
  name: string;
  enabled: boolean;
  schedule: string;
  sources: Source[];
  topic: string;
  basePrompt: string;
  deliveryChannel: 'email' | 'telegram';
  recipientEmail: string;
  telegramChatType: 'dm' | 'group' | null;
  telegramChatId: string | null;
  telegramChatTitle: string | null;
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
  const toast = useToast();
  const [v, setV] = useState<JobFormValues>(
    initial
      ? { ...initial, sources: initial.sources.map(hydrateSource) }
      : {
          name: '',
          enabled: true,
          schedule: '0 8 * * *',
          sources: [{ kind: 'url', url: '' }],
          topic: '',
          basePrompt: '',
          deliveryChannel: 'email',
          recipientEmail: userEmail,
          telegramChatType: null,
          telegramChatId: null,
          telegramChatTitle: null,
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
    next5: { iso: string; formatted: string }[];
    collisions: { jobId: string; name: string }[];
    timezone: string;
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
        setPreview({
          next5: body.next5 ?? [],
          collisions: body.collisions ?? [],
          timezone: body.timezone ?? '',
        });
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
      sources: prev.sources.map((s, idx) => {
        if (idx !== i) return s;
        if (patch.kind && patch.kind !== s.kind) {
          return patch.kind === 'url'
            ? { kind: 'url', url: '', hint: s.hint }
            : { kind: 'search', search: '', hint: s.hint };
        }
        return { ...s, ...patch } as Source;
      }),
    }));
  }
  function addSource() {
    setV((prev) => ({ ...prev, sources: [...prev.sources, { kind: 'url', url: '' }] }));
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
      sources: v.sources
        .filter((s) => (s.kind === 'url' ? s.url.trim() !== '' : s.search.trim() !== ''))
        .map((s) => {
          if (s.kind === 'url') {
            const out: { url: string; hint?: string; needsBrowser?: boolean } = {
              url: s.url.trim(),
            };
            if (s.hint) out.hint = s.hint;
            if (s.needsBrowser) out.needsBrowser = true;
            return out;
          }
          const out: { search: string; hint?: string } = { search: s.search.trim() };
          if (s.hint) out.hint = s.hint;
          return out;
        }),
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
      const msg = body.error ?? `save failed (${res.status})`;
      setErr(msg);
      toast.error(`Save failed: ${msg}`);
      setBusy(false);
      return;
    }
    const saved = await res.json();
    if (runAfter) {
      await fetch(`/api/jobs/${saved.id}/run`, { method: 'POST' });
    }
    setBusy(false);
    router.push('/?toast=job_saved');
    router.refresh();
  }

  async function del() {
    if (!jobId) return;
    if (!confirm('Delete this job and all its runs?')) return;
    setBusy(true);
    const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(`Delete failed: ${body.error ?? res.statusText}`);
      setErr('delete failed');
      return;
    }
    router.push('/?toast=job_deleted');
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', maxWidth: 960 }}
    >
      {/* Row: Name + Enabled */}
      <div style={row('3fr 1fr')}>
        <label style={lbl}>
          Name
          <input
            style={inp}
            value={v.name}
            onChange={(e) => set('name', e.target.value)}
            required
          />
        </label>
        <label style={{ ...lbl, justifyContent: 'flex-end' }}>
          <span style={{ fontSize: '0.85em', color: '#888' }}>Status</span>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0.5rem 0.6rem',
              border: '1px solid #333',
              borderRadius: 3,
              background: '#0b0c0f',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={v.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            <span>{v.enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </label>
      </div>

      {/* Row: Schedule preset + Cron expression */}
      <div style={row('1fr 2fr')}>
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
        </label>
      </div>

      {/* Full-width preview + collision */}
      {preview && preview.next5.length > 0 && (
        <div
          style={{
            padding: '0.55rem 0.75rem',
            border: '1px solid #222',
            borderRadius: 3,
            background: '#0b0d13',
            fontSize: '0.85em',
          }}
        >
          <div style={{ color: '#9ab', marginBottom: 4 }}>
            Next 5 fires{preview.timezone && ` (${preview.timezone})`}:
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: '1.1rem',
              color: '#ccc',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '0.1rem 1rem',
            }}
          >
            {preview.next5.map((t) => (
              <li key={t.iso}>{t.formatted}</li>
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

      {/* Sources */}
      <fieldset style={fs}>
        <legend>Sources</legend>
        {v.sources.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: transient form rows
          <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <select
              style={{ ...inp, width: 90 }}
              value={s.kind}
              onChange={(e) => setSource(i, { kind: e.target.value as 'url' | 'search' })}
              aria-label="Source type"
            >
              <option value="url">URL</option>
              <option value="search">Search</option>
            </select>
            {s.kind === 'url' ? (
              <>
                <input
                  style={{ ...inp, flex: 3 }}
                  placeholder="https://…"
                  value={s.url}
                  onChange={(e) => setSource(i, { url: e.target.value })}
                />
                <input
                  style={{ ...inp, flex: 2 }}
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
              </>
            ) : (
              <>
                <input
                  style={{ ...inp, flex: 3 }}
                  placeholder="search query (Claude WebSearch)"
                  value={s.search}
                  onChange={(e) => setSource(i, { search: e.target.value })}
                />
                <input
                  style={{ ...inp, flex: 2 }}
                  placeholder="hint (optional)"
                  value={s.hint ?? ''}
                  onChange={(e) => setSource(i, { hint: e.target.value })}
                />
              </>
            )}
            <button type="button" onClick={() => removeSource(i)} style={btnGhost}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={addSource} style={btnGhost}>
          + Add source
        </button>
      </fieldset>

      {/* Row: Topic */}
      <div style={row('1fr')}>
        <label style={lbl}>
          Topic
          <input
            style={inp}
            value={v.topic}
            onChange={(e) => set('topic', e.target.value)}
            required
          />
        </label>
      </div>

      {/* Delivery section: channel discriminator + per-channel inputs. */}
      <fieldset style={fs}>
        <legend>Delivery</legend>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <select
            style={{ ...inp, width: 120 }}
            value={v.deliveryChannel}
            onChange={(e) => {
              const ch = e.target.value as 'email' | 'telegram';
              setV((prev) => ({
                ...prev,
                deliveryChannel: ch,
                telegramChatType:
                  ch === 'telegram' ? (prev.telegramChatType ?? 'dm') : prev.telegramChatType,
              }));
            }}
            aria-label="Delivery channel"
          >
            <option value="email">Email</option>
            <option value="telegram">Telegram</option>
          </select>
          {v.deliveryChannel === 'email' ? (
            <input
              style={{ ...inp, flex: 1 }}
              type="email"
              placeholder="Recipient email"
              value={v.recipientEmail}
              onChange={(e) => set('recipientEmail', e.target.value)}
              required
            />
          ) : (
            <select
              style={{ ...inp, width: 140 }}
              value={v.telegramChatType ?? 'dm'}
              onChange={(e) => set('telegramChatType', e.target.value as 'dm' | 'group')}
              aria-label="Telegram chat type"
            >
              <option value="dm">Direct message</option>
              <option value="group">Group</option>
            </select>
          )}
        </div>
        {v.deliveryChannel === 'telegram' && (
          <TelegramLinkSection
            jobId={jobId}
            chatType={v.telegramChatType ?? 'dm'}
            chatId={v.telegramChatId}
            chatTitle={v.telegramChatTitle}
            onLinked={(chatId, chatTitle) =>
              setV((prev) => ({ ...prev, telegramChatId: chatId, telegramChatTitle: chatTitle }))
            }
          />
        )}
      </fieldset>

      {/* Full-width Base prompt */}
      <label style={lbl}>
        Base prompt <small style={{ color: '#888' }}>({v.basePrompt.length} chars)</small>
        <textarea
          style={{ ...inp, minHeight: 160, fontFamily: 'inherit' }}
          value={v.basePrompt}
          onChange={(e) => set('basePrompt', e.target.value)}
          placeholder={BASE_PROMPT_PLACEHOLDER}
          required
        />
        <BasePromptHints />
      </label>

      {/* Output format / Max items / Monthly budget / Min interval — all compact numerics */}
      <div style={row('1fr 1fr 1fr 1fr')}>
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
          Monthly budget
          <input
            style={inp}
            type="number"
            min={1}
            value={v.monthlyBudget}
            onChange={(e) => set('monthlyBudget', Number(e.target.value))}
          />
        </label>
        <label style={lbl}>
          Min interval (min)
          <input
            style={inp}
            type="number"
            min={0}
            placeholder="optional"
            value={v.minIntervalMinutes ?? ''}
            onChange={(e) =>
              set('minIntervalMinutes', e.target.value === '' ? null : Number(e.target.value))
            }
          />
        </label>
      </div>

      {/* Row: model selectors */}
      <div style={row('1fr 1fr')}>
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
      </div>

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

function TelegramLinkSection({
  jobId,
  chatType,
  chatId,
  chatTitle,
  onLinked,
}: {
  jobId: string | undefined;
  chatType: 'dm' | 'group';
  chatId: string | null;
  chatTitle: string | null;
  onLinked: (chatId: string, chatTitle: string | null) => void;
}) {
  const [link, setLink] = useState<{
    token: string;
    deepLink: string | null;
    expiresAt: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: onLinked is a stable setter wrapper from parent; re-running on its identity would restart polling on every parent render
  useEffect(() => {
    if (!link || !jobId) return;
    const expiresMs = new Date(link.expiresAt).getTime();
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (Date.now() > expiresMs) {
        setLink(null);
        setPending(false);
        setErr('Link expired. Generate a new one.');
        return;
      }
      try {
        const res = await fetch(`/api/jobs/${jobId}/telegram-status`);
        if (res.ok) {
          const body = await res.json();
          if (body.linked && body.chatId) {
            onLinked(String(body.chatId), body.chatTitle ?? null);
            setLink(null);
            setPending(false);
            return;
          }
        }
      } catch {
        // transient; keep polling
      }
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 3000);
    return () => {
      stopped = true;
    };
    // We intentionally only re-run when `link` (i.e. the active token) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, jobId]);

  async function generate() {
    if (!jobId) return;
    setErr(null);
    setPending(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/telegram-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: chatType }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `link failed (${res.status})`);
        setPending(false);
        return;
      }
      setLink({
        token: body.token,
        deepLink: body.deepLink ?? null,
        expiresAt: body.expiresAt,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'link failed');
      setPending(false);
    }
  }

  const linked = !!chatId;
  return (
    <div style={{ fontSize: '0.9em' }}>
      <div style={{ marginBottom: 6 }}>
        Status:{' '}
        {linked ? (
          <span style={{ color: '#9ad' }}>
            Linked
            {chatTitle ? ` · ${chatTitle}` : ''} (chat {chatId})
          </span>
        ) : (
          <span style={{ color: '#888' }}>Not linked</span>
        )}
      </div>
      {!jobId ? (
        <div style={{ color: '#888' }}>Save the job first, then link Telegram.</div>
      ) : (
        <>
          <button type="button" onClick={generate} disabled={pending} style={btnGhost}>
            {linked ? 'Re-link Telegram' : 'Link Telegram'}
          </button>
          {link && chatType === 'dm' && link.deepLink && (
            <div style={{ marginTop: 8 }}>
              <a href={link.deepLink} target="_blank" rel="noreferrer" style={{ color: '#7af' }}>
                Open Telegram and press Start
              </a>
              <div style={{ color: '#888', marginTop: 4 }}>
                Waiting for you to press Start… (expires{' '}
                {new Date(link.expiresAt).toLocaleTimeString()})
              </div>
            </div>
          )}
          {link && chatType === 'group' && (
            <div style={{ marginTop: 8 }}>
              <div>Add the bot to your Telegram group, then send this command in the group:</div>
              <code
                style={{
                  display: 'inline-block',
                  marginTop: 4,
                  padding: '0.3rem 0.5rem',
                  background: '#0b0c0f',
                  border: '1px solid #333',
                  borderRadius: 3,
                }}
              >
                /link {link.token}
              </code>
              <div style={{ color: '#888', marginTop: 4 }}>
                Waiting for the command… (expires {new Date(link.expiresAt).toLocaleTimeString()})
              </div>
            </div>
          )}
          {err && <div style={{ color: '#e66', marginTop: 6 }}>{err}</div>}
        </>
      )}
    </div>
  );
}

function row(template: string): React.CSSProperties {
  return { display: 'grid', gridTemplateColumns: template, gap: '1rem', alignItems: 'end' };
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
