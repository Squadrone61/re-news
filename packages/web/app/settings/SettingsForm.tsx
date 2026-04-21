'use client';
import { useState } from 'react';
import { useToast } from '../_components/Toaster';

type Initial = {
  gmailUser: string;
  gmailAppPasswordSet: boolean;
  senderName: string;
  defaultModelResearch: string;
  defaultModelSummary: string;
  workerConcurrency: number;
};

const field: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.3rem',
  margin: '0.7rem 0',
};
const input: React.CSSProperties = {
  background: '#111',
  color: '#e6e6e6',
  border: '1px solid #333',
  padding: '0.4rem 0.6rem',
  borderRadius: 4,
};

export function SettingsForm({ initial }: { initial: Initial }) {
  const [gmailUser, setGmailUser] = useState(initial.gmailUser);
  const [gmailAppPassword, setGmailAppPassword] = useState('');
  const [senderName, setSenderName] = useState(initial.senderName);
  const [defaultModelResearch, setDMR] = useState(initial.defaultModelResearch);
  const [defaultModelSummary, setDMS] = useState(initial.defaultModelSummary);
  const [workerConcurrency, setWC] = useState(initial.workerConcurrency);
  const toast = useToast();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      gmailUser,
      senderName,
      defaultModelResearch,
      defaultModelSummary,
      workerConcurrency,
    };
    if (gmailAppPassword.length > 0) body.gmailAppPassword = gmailAppPassword;
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      toast.error(`Save failed: ${b.error ?? 'save failed'}`);
      return;
    }
    toast.success('Settings saved');
    setGmailAppPassword('');
  }

  return (
    <form onSubmit={save}>
      <label style={field}>
        <span>Gmail user (sender address)</span>
        <input
          style={input}
          type="email"
          value={gmailUser}
          onChange={(e) => setGmailUser(e.target.value)}
          placeholder="newsletter-bot@gmail.com"
        />
      </label>
      <label style={field}>
        <span>
          Gmail app password{' '}
          {initial.gmailAppPasswordSet && (
            <em style={{ color: '#888' }}>(set; leave blank to keep)</em>
          )}
        </span>
        <input
          style={input}
          type="password"
          value={gmailAppPassword}
          onChange={(e) => setGmailAppPassword(e.target.value)}
          placeholder={initial.gmailAppPasswordSet ? '***' : 'xxxx xxxx xxxx xxxx'}
        />
      </label>
      <label style={field}>
        <span>Sender name</span>
        <input
          style={input}
          value={senderName}
          onChange={(e) => setSenderName(e.target.value)}
          placeholder="re-news"
        />
      </label>
      <label style={field}>
        <span>Default research model</span>
        <input
          style={input}
          value={defaultModelResearch}
          onChange={(e) => setDMR(e.target.value)}
        />
      </label>
      <label style={field}>
        <span>Default summary model</span>
        <input style={input} value={defaultModelSummary} onChange={(e) => setDMS(e.target.value)} />
      </label>
      <label style={field}>
        <span>Worker concurrency (informational)</span>
        <input
          style={input}
          type="number"
          min={1}
          max={10}
          value={workerConcurrency}
          onChange={(e) => setWC(Number(e.target.value))}
        />
      </label>
      <div style={{ marginTop: '1rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <button
          type="submit"
          style={{
            background: '#2563eb',
            color: 'white',
            border: 'none',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            borderRadius: 4,
          }}
        >
          Save
        </button>
      </div>
    </form>
  );
}
