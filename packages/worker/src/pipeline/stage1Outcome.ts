import type { ResearchJson } from './research.js';

export type Stage1OutcomeCode = 'stage1_no_signal' | 'stage1_aborted';

export type Stage1Outcome =
  | { kind: 'complete'; research: ResearchJson }
  | { kind: 'partial'; research: ResearchJson; salvagedFromSources: number }
  | { kind: 'no_signal'; reason: string }
  | { kind: 'aborted'; reason: string };

export class Stage1IncompleteError extends Error {
  readonly code: Stage1OutcomeCode;
  constructor(code: Stage1OutcomeCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = 'Stage1IncompleteError';
  }
}
