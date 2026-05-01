import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { salvageFromSources } from '../pipeline/salvage.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'salvage-'));
  await fs.mkdir(path.join(dir, 'sources'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('salvageFromSources', () => {
  it('returns 0 sources when sources/ directory has no usable files', async () => {
    const r = await salvageFromSources(dir);
    expect(r.salvagedCount).toBe(0);
    expect(r.research.items).toEqual([]);
  });

  it('reads valid JSON briefs and builds a merged ResearchJson', async () => {
    await fs.writeFile(
      path.join(dir, 'sources', '0.json'),
      JSON.stringify({
        source_url: 'https://a.example',
        items: [{ title: 'A', url: 'https://a.example/1', summary: 'x' }],
        fetch_errors: [],
      }),
    );
    await fs.writeFile(
      path.join(dir, 'sources', '1.json'),
      JSON.stringify({
        source_url: 'https://b.example',
        items: [],
        fetch_errors: [{ code: 'blocked', detail: 'cf' }],
      }),
    );
    const r = await salvageFromSources(dir);
    expect(r.salvagedCount).toBe(2);
    expect(r.research.items).toHaveLength(1);
    expect(r.research.items?.[0]).toMatchObject({
      title: 'A',
      url: 'https://a.example/1',
      source_url: 'https://a.example',
    });
    expect(r.research.fetch_errors).toEqual([{ code: 'blocked', detail: 'cf' }]);
  });

  it('skips files that fail SourceBriefSchema validation', async () => {
    await fs.writeFile(path.join(dir, 'sources', '0.json'), '{not json');
    await fs.writeFile(
      path.join(dir, 'sources', '1.json'),
      JSON.stringify({ source_url: 'x', items: [], fetch_errors: [] }),
    );
    const r = await salvageFromSources(dir);
    expect(r.salvagedCount).toBe(1);
  });
});
