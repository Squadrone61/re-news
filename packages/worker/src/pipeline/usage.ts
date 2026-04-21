import { logger, prisma } from '@renews/shared';

export type UsageTotals = {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export function emptyUsage(): UsageTotals {
  return { tokensIn: 0, tokensOut: 0, costUsd: 0 };
}

/**
 * Best-effort extraction of token/cost data from a single SDK message.
 * Returns 0s on any unknown shape — never throws. The SDK's `result` message
 * is the most reliable carrier; some providers also tuck `usage` into
 * intermediate assistant messages.
 */
export function extractUsage(msg: unknown): UsageTotals {
  const out = emptyUsage();
  if (!msg || typeof msg !== 'object') return out;
  try {
    const m = msg as Record<string, unknown>;

    // Candidate shapes, in order of what we've seen:
    //   { type: 'result', usage: { input_tokens, output_tokens }, total_cost_usd }
    //   { type: 'assistant', message: { usage: { input_tokens, output_tokens } } }
    //   { usage: {...} } or { model_usage: {...} }
    const candidates: unknown[] = [
      m.usage,
      m.model_usage,
      (m.message as Record<string, unknown> | undefined)?.usage,
    ];
    for (const c of candidates) {
      if (c && typeof c === 'object') {
        const u = c as Record<string, unknown>;
        if (typeof u.input_tokens === 'number') out.tokensIn += u.input_tokens;
        if (typeof u.output_tokens === 'number') out.tokensOut += u.output_tokens;
        if (typeof u.cache_creation_input_tokens === 'number')
          out.tokensIn += u.cache_creation_input_tokens;
        if (typeof u.cache_read_input_tokens === 'number')
          out.tokensIn += u.cache_read_input_tokens;
      }
    }
    const costCandidates: unknown[] = [m.total_cost_usd, m.cost_usd, m.total_cost];
    for (const c of costCandidates) {
      if (typeof c === 'number' && Number.isFinite(c)) {
        out.costUsd += c;
      }
    }
  } catch {
    // never throw from usage capture
  }
  return out;
}

export function addUsage(a: UsageTotals, b: UsageTotals): void {
  a.tokensIn += b.tokensIn;
  a.tokensOut += b.tokensOut;
  a.costUsd += b.costUsd;
}

export async function persistUsage(runId: string, totals: UsageTotals): Promise<void> {
  if (totals.tokensIn === 0 && totals.tokensOut === 0 && totals.costUsd === 0) return;
  try {
    await prisma.run.update({
      where: { id: runId },
      data: {
        tokensIn: totals.tokensIn > 0 ? totals.tokensIn : null,
        tokensOut: totals.tokensOut > 0 ? totals.tokensOut : null,
        costUsd: totals.costUsd > 0 ? totals.costUsd.toFixed(4) : null,
      },
    });
  } catch (err) {
    logger.warn(`usage persist failed for ${runId}:`, err);
  }
}
