'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function SetupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/setup-status')
      .then((r) => r.json())
      .then((d) => {
        if (!d.needsSetup) router.replace('/login');
        else setReady(true);
      })
      .catch(() => setReady(true));
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setErr(body.error ?? 'setup failed');
      return;
    }
    router.replace('/');
    router.refresh();
  }

  if (!ready) return null;

  return (
    <main style={wrap}>
      <form onSubmit={onSubmit} style={card}>
        <h1 style={{ margin: 0 }}>Welcome</h1>
        <p style={{ color: '#888', margin: 0 }}>Create the first admin account.</p>
        <label style={lbl}>
          Email
          <input
            style={inp}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label style={lbl}>
          Password (≥8 chars)
          <input
            style={inp}
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {err && <p style={{ color: '#e66', margin: 0 }}>{err}</p>}
        <button type="submit" disabled={submitting} style={btn}>
          {submitting ? '…' : 'Create admin'}
        </button>
      </form>
    </main>
  );
}

const wrap: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
  padding: '1rem',
};
const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  width: '100%',
  maxWidth: 420,
  background: '#111319',
  padding: '1.5rem',
  border: '1px solid #222',
  borderRadius: 6,
};
const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const inp: React.CSSProperties = {
  background: '#0b0c0f',
  color: '#e6e6e6',
  border: '1px solid #333',
  padding: '0.5rem',
  borderRadius: 3,
};
const btn: React.CSSProperties = {
  background: '#2a6fdb',
  color: 'white',
  border: 0,
  padding: '0.6rem',
  borderRadius: 3,
  cursor: 'pointer',
};
