import type { Job } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { buildResearchPrompt } from '../research.js';

function makeJob(sources: unknown): Job {
  return {
    id: 'job-1',
    userId: 'u-1',
    name: 'test',
    topic: 'tech',
    schedule: '0 8 * * *',
    sources: sources as Job['sources'],
    prompt: '',
    recipientEmail: 'a@b.co',
    enabled: true,
    minIntervalMinutes: 0,
    monthlyBudget: null,
    modelResearch: 'claude-sonnet-4-6',
    modelSummary: 'claude-haiku-4-5',
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Job;
}

describe('buildResearchPrompt', () => {
  it('omits browser instructions when no source is needs_browser', () => {
    const job = makeJob([{ url: 'https://example.com' }]);
    const prompt = buildResearchPrompt(job, '/abs/path/research.json');
    expect(prompt).not.toContain('[use browser]');
    expect(prompt).not.toContain('mcp__playwright__browser_');
    expect(prompt).toContain('WebFetch for static HTML');
  });

  it('emits browser tool instructions when a source is marked needs_browser', () => {
    const job = makeJob([
      { url: 'https://static.example.com' },
      { url: 'https://spa.example.com', needs_browser: true },
    ]);
    const prompt = buildResearchPrompt(job, '/abs/path/research.json');
    expect(prompt).toContain('[use browser]');
    expect(prompt).toContain('mcp__playwright__browser_navigate');
    expect(prompt).toContain('mcp__playwright__browser_snapshot');
    expect(prompt).toContain('browser_failed');
    expect(prompt).toContain('browser_timeout');
  });

  it('accepts camelCase needsBrowser as well', () => {
    const job = makeJob([{ url: 'https://x', needsBrowser: true }]);
    const prompt = buildResearchPrompt(job, '/abs/path/research.json');
    expect(prompt).toContain('[use browser]');
  });
});
