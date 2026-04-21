'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toaster';

type Props = {
  runId: string;
  status: string; // current run status
  size?: 'sm' | 'md';
  onStopped?: () => void;
};

const STOPPABLE = new Set(['queued', 'running']);

export function StopRunButton({ runId, status, size = 'sm', onStopped }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!STOPPABLE.has(status)) return null;

  async function doStop() {
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${runId}/stop`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(`Stop failed: ${body.error ?? res.statusText}`);
      } else if (body.status === 'cancelled') {
        toast.success('Run stopped');
        onStopped?.();
        router.refresh();
      } else {
        toast.info('Stopping…');
        onStopped?.();
        router.refresh();
      }
    } catch (e) {
      toast.error(`Stop failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  const padding = size === 'sm' ? '0.25rem 0.6rem' : '0.4rem 0.8rem';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy}
        style={{
          background: 'transparent',
          color: '#f7c6c6',
          border: '1px solid #a8323a',
          padding,
          cursor: 'pointer',
          borderRadius: 3,
          fontSize: size === 'sm' ? '0.85em' : '1em',
        }}
      >
        {busy ? 'Stopping…' : 'Stop'}
      </button>
      <ConfirmDialog
        open={open}
        title="Stop this run?"
        body="Any partial work will be discarded."
        confirmLabel="Stop"
        cancelLabel="Keep running"
        destructive
        onConfirm={doStop}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
