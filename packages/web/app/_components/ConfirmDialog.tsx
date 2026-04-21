'use client';
import { useEffect, useRef } from 'react';

type Props = {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: Props) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // Focus the safer choice by default for destructive prompts.
      cancelBtnRef.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault(); // we handle close ourselves so onCancel is reliable
        onCancel();
      }}
      style={{
        background: '#13151a',
        color: '#e6e6e6',
        border: '1px solid #333',
        borderRadius: 4,
        padding: 0,
        minWidth: 320,
        maxWidth: 480,
      }}
    >
      <div style={{ padding: '1rem 1.25rem 1.25rem' }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.05em' }}>{title}</h2>
        {body && <p style={{ margin: '0 0 1rem', color: '#bbb', fontSize: '0.95em' }}>{body}</p>}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={onCancel}
            style={{
              background: 'transparent',
              color: '#e6e6e6',
              border: '1px solid #444',
              padding: '0.4rem 0.9rem',
              cursor: 'pointer',
              borderRadius: 3,
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              background: destructive ? '#a8323a' : '#2a6fdb',
              color: 'white',
              border: 0,
              padding: '0.4rem 0.9rem',
              cursor: 'pointer',
              borderRadius: 3,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
