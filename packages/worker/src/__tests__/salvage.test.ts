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

  it('skips unreadable / invalid-JSON / schema-failing files and reports them', async () => {
    await fs.writeFile(path.join(dir, 'sources', '0.json'), '{not json');
    await fs.writeFile(
      path.join(dir, 'sources', '1.json'),
      JSON.stringify({ source_url: 'not-a-url', items: [], fetch_errors: [] }),
    );
    await fs.writeFile(
      path.join(dir, 'sources', '2.json'),
      JSON.stringify({ source_url: 'https://ok.example', items: [], fetch_errors: [] }),
    );
    const r = await salvageFromSources(dir);
    expect(r.salvagedCount).toBe(1);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped.some((s) => s.file === '0.json' && /JSON parse/.test(s.reason))).toBe(true);
    expect(r.skipped.some((s) => s.file === '1.json' && /schema/.test(s.reason))).toBe(true);
  });

  it('keeps briefs that exceed the strict caps (length warns happen post-salvage)', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      title: `T${i}`,
      url: `https://example.com/${i}`,
      summary: 'x'.repeat(1500),
    }));
    await fs.writeFile(
      path.join(dir, 'sources', '0.json'),
      JSON.stringify({
        source_url: 'https://example.com',
        items,
        fetch_errors: [],
      }),
    );
    const r = await salvageFromSources(dir);
    expect(r.salvagedCount).toBe(1);
    expect(r.research.items).toHaveLength(20);
    expect((r.research.items?.[0] as { summary: string }).summary.length).toBe(1500);
  });
});
