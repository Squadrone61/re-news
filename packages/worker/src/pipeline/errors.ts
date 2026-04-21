export class RateLimitError extends Error {
  readonly resetAt: Date;
  constructor(message: string, resetAt: Date) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

const RATE_LIMIT_PATTERNS = [
  /rate[_\s-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /quota exceeded/i,
];

export function detectRateLimit(err: unknown): RateLimitError | null {
  if (err instanceof RateLimitError) return err;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!msg) return null;
  for (const p of RATE_LIMIT_PATTERNS) {
    if (p.test(msg)) {
      const resetAt = parseResetTime(err, msg) ?? new Date(Date.now() + 5 * 60 * 60_000);
      return new RateLimitError(`rate_limit: window resets at ${resetAt.toISOString()}`, resetAt);
    }
  }
  return null;
}

function parseResetTime(err: unknown, msg: string): Date | null {
  if (err && typeof err === 'object') {
    const r = (err as { resetAt?: unknown }).resetAt;
    if (r instanceof Date) return r;
    if (typeof r === 'string') {
      const d = new Date(r);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const headers = (err as { headers?: Record<string, unknown> }).headers;
    if (headers && typeof headers === 'object') {
      const h = headers['retry-after'] ?? headers['Retry-After'];
      if (typeof h === 'string' || typeof h === 'number') {
        const secs = Number(h);
        if (Number.isFinite(secs) && secs > 0) return new Date(Date.now() + secs * 1000);
      }
    }
  }
  const isoMatch = msg.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s"']*)/);
  if (isoMatch) {
    const d = new Date(isoMatch[1]!);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}
