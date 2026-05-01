import { describe, expect, it } from 'vitest';
import { summarizeFetchErrors } from '../researchSummary.js';

describe('summarizeFetchErrors', () => {
  it('returns zero summary when researchRaw is null/undefined', () => {
    expect(summarizeFetchErrors(null)).toEqual({ total: 0, byCode: {} });
    expect(summarizeFetchErrors(undefined)).toEqual({ total: 0, byCode: {} });
  });

  it('returns zero summary when fetch_errors is missing or not an array', () => {
    expect(summarizeFetchErrors({})).toEqual({ total: 0, byCode: {} });
    expect(summarizeFetchErrors({ fetch_errors: 'oops' })).toEqual({ total: 0, byCode: {} });
  });

  it('counts errors and groups by code', () => {
    const researchRaw = {
      items: [],
      fetch_errors: [
        { code: 'blocked', detail: 'cf' },
        { code: 'blocked', detail: 'cf2' },
        { code: 'browser_failed', detail: 'err_aborted' },
        { code: 'no_results', detail: 'q' },
      ],
    };
    expect(summarizeFetchErrors(researchRaw)).toEqual({
      total: 4,
      byCode: { blocked: 2, browser_failed: 1, no_results: 1 },
    });
  });

  it('skips entries with non-string code', () => {
    const researchRaw = {
      fetch_errors: [
        { code: 'blocked' },
        { detail: 'no code field' },
        { code: 42 },
        null,
      ],
    };
    expect(summarizeFetchErrors(researchRaw)).toEqual({
      total: 1,
      byCode: { blocked: 1 },
    });
  });
});
