import { describe, expect, it } from 'vitest';
import { renderTelegramHtml } from '../render-telegram.js';
import type { StageTwo } from '../schemas.js';

function makeStageTwo(overrides: Partial<StageTwo> = {}): StageTwo {
  return {
    subject: 'Test newsletter',
    intro: 'A short intro.',
    items: [
      {
        headline: 'Item one',
        body: 'Body of item one.',
        source_url: 'https://example.com/one',
      },
    ],
    ...overrides,
  };
}

describe('renderTelegramHtml', () => {
  it('renders subject as <b> and emits a single chunk for small input', () => {
    const chunks = renderTelegramHtml(makeStageTwo());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('<b>Test newsletter</b>');
    expect(chunks[0]).toContain('<b>Item one</b>');
    expect(chunks[0]).toContain('<a href="https://example.com/one">Source</a>');
    expect(chunks[0]).toContain('A short intro.');
  });

  it('escapes HTML-sensitive characters in headlines and bodies', () => {
    const chunks = renderTelegramHtml(
      makeStageTwo({
        subject: 'A & B',
        items: [
          {
            headline: '<dangerous>',
            body: 'A < B > C & D',
            source_url: 'https://example.com/x',
          },
        ],
      }),
    );
    const out = chunks.join('\n');
    expect(out).toContain('A &amp; B');
    expect(out).toContain('&lt;dangerous&gt;');
    expect(out).toContain('A &lt; B &gt; C &amp; D');
    expect(out).not.toContain('<dangerous>');
  });

  it('groups items by category when any item has one', () => {
    const chunks = renderTelegramHtml(
      makeStageTwo({
        items: [
          {
            headline: 'A',
            body: 'a',
            source_url: 'https://example.com/a',
            category: 'Politics',
          },
          {
            headline: 'B',
            body: 'b',
            source_url: 'https://example.com/b',
            category: 'Sports',
          },
          {
            headline: 'C',
            body: 'c',
            source_url: 'https://example.com/c',
            category: 'Politics',
          },
        ],
      }),
    );
    const out = chunks.join('\n');
    expect(out).toContain('━ Politics ━');
    expect(out).toContain('━ Sports ━');
    // Politics block appears before Sports
    expect(out.indexOf('Politics')).toBeLessThan(out.indexOf('Sports'));
  });

  it('splits across multiple chunks when items exceed the 4000-char ceiling', () => {
    const bigBody = 'x'.repeat(2000);
    const chunks = renderTelegramHtml(
      makeStageTwo({
        items: Array.from({ length: 4 }, (_, i) => ({
          headline: `Headline ${i}`,
          body: bigBody,
          source_url: `https://example.com/${i}`,
        })),
      }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4000);
    }
  });

  it('truncates a single oversize item body with an ellipsis', () => {
    const chunks = renderTelegramHtml(
      makeStageTwo({
        items: [
          {
            headline: 'Whale of a tale',
            body: 'x'.repeat(8000),
            source_url: 'https://example.com/whale',
          },
        ],
      }),
    );
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    expect(chunks.join('\n')).toContain('…');
  });

  it('falls back to empty_reason when items is empty', () => {
    const chunks = renderTelegramHtml(
      makeStageTwo({ items: [], empty_reason: 'No sources returned anything today.' }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('No sources returned anything today.');
  });

  it('rewrites non-http(s) source links to # to prevent javascript: smuggling', () => {
    const chunks = renderTelegramHtml(
      makeStageTwo({
        items: [
          {
            headline: 'Sketchy',
            body: 'b',
            source_url: 'javascript:alert(1)' as unknown as string,
          },
        ],
      }),
    );
    expect(chunks[0]).toContain('<a href="#">Source</a>');
    expect(chunks[0]).not.toContain('javascript:');
  });
});
