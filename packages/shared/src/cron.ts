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
