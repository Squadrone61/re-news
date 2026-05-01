import { describe, expect, it } from 'vitest';
import { Stage1IncompleteError } from '../pipeline/stage1Outcome.js';
import type { Stage1Outcome } from '../pipeline/stage1Outcome.js';

describe('Stage1IncompleteError', () => {
  it('carries a reason and is an Error', () => {
    const e = new Stage1IncompleteError('stage1_no_signal', 'no sources completed');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('stage1_no_signal');
    expect(e.message).toContain('no sources completed');
  });

  it('Stage1Outcome discriminates on kind', () => {
    const outcomes: Stage1Outcome[] = [
      { kind: 'complete', research: { items: [], fetch_errors: [] } },
      {
        kind: 'partial',
        research: { items: [], fetch_errors: [] },
        salvagedFromSources: 2,
      },
      { kind: 'no_signal', reason: 'all sources empty' },
      { kind: 'aborted', reason: 'sdk exited code 1' },
    ];
    const kinds = outcomes.map((o) => o.kind);
    expect(kinds).toEqual(['complete', 'partial', 'no_signal', 'aborted']);
  });
});
