'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type ToastKind = 'success' | 'error' | 'info';
type Toast = { id: string; kind: ToastKind; message: string };

type ToastApi = {
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
};

const Ctx = createContext<ToastApi | null>(null);

const MAX_STACK = 3;
const AUTO_DISMISS_MS = 4000;

// Registry of redirect-toast keys. `?toast=<key>` on the destination page fires
// the matching toast once and clears the param. Keep this central so strings
// don't drift between source and destination.
export const REDIRECT_TOASTS: Record<string, { kind: ToastKind; message: string }> = {
  job_saved: { kind: 'success', message: 'Job saved' },
  job_deleted: { kind: 'success', message: 'Job deleted' },
  settings_saved: { kind: 'success', message: 'Settings saved' },
};

export function ToasterProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = `${Date.now()}-${counterRef.current++}`;
    setToasts((prev) => {
      const next = [...prev, { id, kind, message }];
      return next.length > MAX_STACK ? next.slice(next.length - MAX_STACK) : next;
    });
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <Viewport
        toasts={toasts}
        onClose={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))}
      />
      <RedirectToastConsumer />
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast: ToasterProvider missing');
  return v;
}

function Viewport({ toasts, onClose }: { toasts: Toast[]; onClose: (id: string) => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: '1rem',
        right: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        zIndex: 1000,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
          style={{
            background:
              t.kind === 'error' ? '#2a1517' : t.kind === 'success' ? '#152a1c' : '#152027',
            border: `1px solid ${
              t.kind === 'error' ? '#d04545' : t.kind === 'success' ? '#2a9d4f' : '#2a6fdb'
            }`,
            color: '#e6e6e6',
            padding: '0.6rem 0.8rem',
            borderRadius: 3,
            minWidth: 220,
            maxWidth: 380,
            display: 'flex',
            gap: '0.6rem',
            alignItems: 'flex-start',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          <span style={{ flex: 1, fontSize: '0.9em' }}>{t.message}</span>
          <button
            type="button"
            onClick={() => onClose(t.id)}
            aria-label="dismiss"
            style={{
              background: 'transparent',
              border: 0,
              color: '#9ab',
              cursor: 'pointer',
              fontSize: '1em',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function RedirectToastConsumer() {
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const firedRef = useRef<string | null>(null);

  useEffect(() => {
    const key = sp.get('toast');
    if (!key || firedRef.current === key) return;
    const entry = REDIRECT_TOASTS[key];
    if (entry) {
      firedRef.current = key;
      toast[entry.kind](entry.message);
      // strip the param from the URL without adding history
      const next = new URLSearchParams(sp.toString());
      next.delete('toast');
      const qs = next.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    }
  }, [sp, router, toast]);

  return null;
}
