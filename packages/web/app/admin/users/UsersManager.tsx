'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useToast } from '../../_components/Toaster';

type U = { id: string; email: string; isAdmin: boolean; createdAt: string };

export function UsersManager({ meId, initial }: { meId: string; initial: U[] }) {
  const router = useRouter();
  const [users, setUsers] = useState<U[]>(initial);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, isAdmin }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setErr(b.error ?? 'create failed');
      toast.error(`Create failed: ${b.error ?? 'create failed'}`);
      return;
    }
    const created = await res.json();
    setUsers((prev) => [...prev, created]);
    setEmail('');
    setPassword('');
    setIsAdmin(false);
    toast.success('User created');
    router.refresh();
  }

  async function toggleAdmin(u: U) {
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isAdmin: !u.isAdmin }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      toast.error(`Update failed: ${b.error ?? 'update failed'}`);
      return;
    }
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, isAdmin: !u.isAdmin } : x)));
    toast.success(u.isAdmin ? 'Admin removed' : 'Admin granted');
  }

  async function resetPassword(u: U) {
    const pw = prompt(`New password for ${u.email}:`);
    if (!pw) return;
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      toast.error(`Reset failed: ${b.error ?? 'reset failed'}`);
      return;
    }
    toast.success('Password reset');
  }

  async function del(u: U) {
    if (!confirm(`Delete ${u.email}?`)) return;
    const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      toast.error(`Delete failed: ${b.error ?? 'delete failed'}`);
      return;
    }
    setUsers((prev) => prev.filter((x) => x.id !== u.id));
    toast.success('User deleted');
    router.refresh();
  }

  return (
    <>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '2rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#888' }}>
            <th style={th}>Email</th>
            <th style={th}>Admin</th>
            <th style={th}>Created</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} style={{ borderTop: '1px solid #222' }}>
              <td style={td}>
                {u.email}
                {u.id === meId && <span style={{ color: '#888' }}> (you)</span>}
              </td>
              <td style={td}>
                <input
                  type="checkbox"
                  checked={u.isAdmin}
                  onChange={() => toggleAdmin(u)}
                  disabled={u.id === meId}
                />
              </td>
              <td style={td}>{new Date(u.createdAt).toLocaleString()}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                <button type="button" onClick={() => resetPassword(u)} style={btnGhost}>
                  Reset password
                </button>{' '}
                <button
                  type="button"
                  disabled={u.id === meId}
                  onClick={() => del(u)}
                  style={{ ...btnGhost, color: '#e66', borderColor: '#633' }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form
        onSubmit={createUser}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 420 }}
      >
        <h2 style={{ margin: 0 }}>Create user</h2>
        <input
          style={inp}
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          style={inp}
          type="password"
          placeholder="password (≥8 chars)"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <label style={{ display: 'flex', gap: 6 }}>
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Admin
        </label>
        {err && <p style={{ color: '#e66', margin: 0 }}>{err}</p>}
        <button type="submit" style={btn}>
          Create
        </button>
      </form>
    </>
  );
}

const th: React.CSSProperties = { padding: '0.5rem 0.75rem', fontWeight: 500 };
const td: React.CSSProperties = { padding: '0.6rem 0.75rem' };
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
const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: '#e6e6e6',
  border: '1px solid #444',
  padding: '0.3rem 0.7rem',
  borderRadius: 3,
  cursor: 'pointer',
};
