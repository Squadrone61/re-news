import { getCurrentUser } from '@/src/lib/session';
import { prisma } from '@renews/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Topbar } from '../_components/Topbar';
import { SettingsForm } from './SettingsForm';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const me = await getCurrentUser();
  if (!me) redirect('/login');
  if (!me.isAdmin) redirect('/');

  const row = await prisma.setting.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const accountInfo = await readAccountInfo();

  return (
    <>
      <Topbar email={me.email} isAdmin={me.isAdmin} />
      <main style={{ padding: '1.5rem', maxWidth: 720 }}>
        <Link href="/" style={{ color: '#9ab' }}>
          ← Back
        </Link>
        <h1>Settings</h1>
        <p style={{ color: '#888' }}>
          Shared sender + default models. Applies to all users' newsletters.
        </p>
        <SettingsForm
          initial={{
            gmailUser: row.gmailUser ?? '',
            gmailAppPasswordSet: !!row.gmailAppPassword,
            senderName: row.senderName ?? '',
            defaultModelResearch: row.defaultModelResearch,
            defaultModelSummary: row.defaultModelSummary,
            workerConcurrency: row.workerConcurrency,
          }}
        />
        <AccountInfoPanel info={accountInfo} />
        <footer style={{ marginTop: '2rem', color: '#888', fontSize: '0.9em' }}>
          <p>
            Server time: <code>{tz}</code>. All schedules are interpreted in this timezone.
          </p>
        </footer>
      </main>
    </>
  );
}

type AccountInfo = {
  plan?: string;
  tier?: string;
  email?: string;
  refreshedAt?: string;
} | null;

async function readAccountInfo(): Promise<
  | { kind: 'ok'; data: AccountInfo; ageMs: number }
  | { kind: 'missing' }
  | { kind: 'stale'; ageMs: number }
> {
  const { readFile, stat } = await import('node:fs/promises');
  const path = process.env.ACCOUNT_INFO_PATH ?? '/app/data/account_info.json';
  try {
    const s = await stat(path);
    const ageMs = Date.now() - s.mtimeMs;
    const raw = await readFile(path, 'utf8');
    const data = JSON.parse(raw) as AccountInfo;
    if (ageMs > 10 * 60 * 1000) return { kind: 'stale', ageMs };
    return { kind: 'ok', data, ageMs };
  } catch {
    return { kind: 'missing' };
  }
}

function AccountInfoPanel({
  info,
}: {
  info: Awaited<ReturnType<typeof readAccountInfo>>;
}) {
  const box: React.CSSProperties = {
    marginTop: '1.5rem',
    padding: '0.75rem 1rem',
    border: '1px solid #333',
    borderRadius: 4,
    background: '#0b0d13',
  };
  if (info.kind === 'missing') {
    return (
      <div style={box}>
        <strong>Claude account</strong>{' '}
        <span style={{ color: '#c08a2e' }}>
          auth unknown — run <code>claude</code> on host to establish credentials
        </span>
      </div>
    );
  }
  if (info.kind === 'stale') {
    return (
      <div style={box}>
        <strong>Claude account</strong>{' '}
        <span style={{ color: '#c08a2e' }}>stale ({Math.round(info.ageMs / 60000)} min old)</span>
      </div>
    );
  }
  const d = info.data ?? {};
  const parts: { key: string; node: React.ReactNode }[] = [];
  if (d.plan)
    parts.push({
      key: 'plan',
      node: (
        <>
          plan: <code>{d.plan}</code>
        </>
      ),
    });
  if (d.tier)
    parts.push({
      key: 'tier',
      node: (
        <>
          tier: <code>{d.tier}</code>
        </>
      ),
    });
  if (d.email) parts.push({ key: 'email', node: <code>{d.email}</code> });
  if (d.refreshedAt)
    parts.push({
      key: 'refreshedAt',
      node: <>refreshed {new Date(d.refreshedAt).toLocaleString()}</>,
    });
  return (
    <div style={box}>
      <strong>Claude account</strong>
      <div style={{ color: '#9ab', marginTop: 4 }}>
        {parts.map((p, i) => (
          <span key={p.key}>
            {i > 0 && ' · '}
            {p.node}
          </span>
        ))}
      </div>
    </div>
  );
}
