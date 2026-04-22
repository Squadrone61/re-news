'use client';
import { useEffect, useState } from 'react';

type Mode = 'datetime' | 'time' | 'relative';

export function LocalTime({ iso, mode = 'datetime' }: { iso: string; mode?: Mode }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date(iso);
    if (mode === 'time') setText(d.toLocaleTimeString());
    else if (mode === 'relative') setText(formatRelative(d));
    else setText(d.toLocaleString());
  }, [iso, mode]);
  return <span suppressHydrationWarning>{text ?? ''}</span>;
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
