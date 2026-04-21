import { CronExpressionParser } from 'cron-parser';

export function validateCron(expr: string): { ok: true } | { ok: false; error: string } {
  try {
    CronExpressionParser.parse(expr);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid cron' };
  }
}

export function nextFireAt(expr: string, from: Date = new Date()): Date | null {
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: from });
    return it.next().toDate();
  } catch {
    return null;
  }
}

export function lookbackFromSchedule(expr: string): string {
  try {
    const it = CronExpressionParser.parse(expr);
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    const ms = b - a;
    const hours = ms / 3_600_000;
    if (hours >= 24 * 7) return 'last 7 days';
    if (hours >= 24) return 'last 24 hours';
    if (hours >= 1) return 'last 6 hours';
    return 'recent';
  } catch {
    return 'recent';
  }
}
