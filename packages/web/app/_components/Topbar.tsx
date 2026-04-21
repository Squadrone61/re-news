'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export function Topbar({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  const router = useRouter();
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        padding: '0.75rem 1.5rem',
        background: '#111319',
        borderBottom: '1px solid #222',
      }}
    >
      <Link href="/" style={{ color: '#e6e6e6', textDecoration: 'none', fontWeight: 600 }}>
        re-news
      </Link>
      <Link href="/runs" style={{ color: '#9ab', textDecoration: 'none' }}>
        Runs
      </Link>
      <div style={{ flex: 1 }} />
      {isAdmin && (
        <>
          <Link href="/admin/users" style={{ color: '#9ab', textDecoration: 'none' }}>
            Admin
          </Link>
          <Link href="/settings" style={{ color: '#9ab', textDecoration: 'none' }}>
            Settings
          </Link>
        </>
      )}
      <span style={{ color: '#888' }}>{email}</span>
      <button
        onClick={logout}
        type="button"
        style={{
          background: 'transparent',
          color: '#e6e6e6',
          border: '1px solid #444',
          padding: '0.3rem 0.7rem',
          cursor: 'pointer',
        }}
      >
        Logout
      </button>
    </header>
  );
}
