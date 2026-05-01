import fs from 'node:fs/promises';
import path from 'node:path';
import { SourceBriefShapeSchema } from '@renews/shared';
import type { ResearchJson } from './research.js';

export type SalvageResult = {
  salvagedCount: number;
  research: ResearchJson;
  /** Per-file rejection reasons — caller logs these so the skip isn't invisible. */
  skipped: Array<{ file: string; reason: string }>;
};

export async function salvageFromSources(cwd: string): Promise<SalvageResult> {
  const dir = path.join(cwd, 'sources');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { salvagedCount: 0, research: emptyResearch(), skipped: [] };
  }
  const items: Array<Record<string, unknown>> = [];
  const fetchErrors: Array<Record<string, unknown>> = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  let salvaged = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    let raw: string;
    try {
      raw = await fs.readFile(full, 'utf8');
    } catch (e) {
      skipped.push({ file: name, reason: `read failed: ${errStr(e)}` });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      skipped.push({ file: name, reason: `JSON parse: ${errStr(e)}` });
      continue;
    }
    const brief = SourceBriefShapeSchema.safeParse(parsed);
    if (!brief.success) {
      skipped.push({
        file: name,
        reason: `schema: ${brief.error.issues[0]?.message ?? 'invalid'}`,
      });
      continue;
    }
    salvaged += 1;
    for (const it of brief.data.items) {
      items.push({ ...it, source_url: brief.data.source_url });
    }
    for (const err of brief.data.fetch_errors) fetchErrors.push(err);
  }
  return {
    salvagedCount: salvaged,
    research: {
      fetched_at: new Date().toISOString(),
      items,
      fetch_errors: fetchErrors,
    },
    skipped,
  };
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function emptyResearch(): ResearchJson {
  return { fetched_at: new Date().toISOString(), items: [], fetch_errors: [] };
}
