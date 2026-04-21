'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/setup-status')
      .then((r) => r.json())
      .then((d) => {
        if (d.needsSetup) router.replace('/setup');
      })
      .catch(() => {});
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setErr(body.error ?? 'login failed');
      return;
    }
    router.replace(params.get('redirect') ?? '/');
    router.refresh();
  }

  return (
    <main style={wrap}>
      <form onSubmit={onSubmit} style={card}>
        <h1 style={{ margin: 0 }}>Log in</h1>
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
          Password
          <input
            style={inp}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {err && <p style={{ color: '#e66', margin: 0 }}>{err}</p>}
        <button type="submit" disabled={submitting} style={btn}>
          {submitting ? '…' : 'Log in'}
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
  maxWidth: 380,
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
