export type FetchErrorSummary = {
  total: number;
  byCode: Record<string, number>;
};

export function summarizeFetchErrors(researchRaw: unknown): FetchErrorSummary {
  const empty: FetchErrorSummary = { total: 0, byCode: {} };
  if (!researchRaw || typeof researchRaw !== 'object') return empty;
  const errs = (researchRaw as { fetch_errors?: unknown }).fetch_errors;
  if (!Array.isArray(errs)) return empty;
  const byCode: Record<string, number> = {};
  let total = 0;
  for (const e of errs) {
    if (!e || typeof e !== 'object') continue;
    const code = (e as { code?: unknown }).code;
    if (typeof code !== 'string') continue;
    byCode[code] = (byCode[code] ?? 0) + 1;
    total += 1;
  }
  return { total, byCode };
}
