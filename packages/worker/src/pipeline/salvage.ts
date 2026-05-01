import fs from 'node:fs/promises';
import path from 'node:path';
import { SourceBriefSchema } from '@renews/shared';
import type { ResearchJson } from './research.js';

export async function salvageFromSources(
  cwd: string,
): Promise<{ salvagedCount: number; research: ResearchJson }> {
  const dir = path.join(cwd, 'sources');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { salvagedCount: 0, research: emptyResearch() };
  }
  const items: Array<Record<string, unknown>> = [];
  const fetchErrors: Array<Record<string, unknown>> = [];
  let salvaged = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    let raw: string;
    try {
      raw = await fs.readFile(full, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const brief = SourceBriefSchema.safeParse(parsed);
    if (!brief.success) continue;
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
  };
}

function emptyResearch(): ResearchJson {
  return { fetched_at: new Date().toISOString(), items: [], fetch_errors: [] };
}
