import { describe, expect, it } from 'vitest';
import { nextFireAt, validateCron } from '../cron.js';
import {
  JobInput,
  LoginInput,
  SourceBriefSchema,
  SourceInput,
  UserCreateInput,
} from '../schemas.js';

describe('JobInput', () => {
  const base = {
    name: 'Test',
    schedule: '0 8 * * *',
    sources: [{ url: 'https://example.com' }],
    topic: 'test',
    basePrompt: 'be terse',
    recipientEmail: 'a@b.co',
  };

  it('applies defaults', () => {
    const p = JobInput.parse(base);
    expect(p.outputFormat).toBe('markdown');
    expect(p.maxItems).toBe(6);
    expect(p.enabled).toBe(true);
    expect(p.monthlyBudget).toBe(60);
  });

  it('rejects bad recipient email', () => {
    expect(JobInput.safeParse({ ...base, recipientEmail: 'nope' }).success).toBe(false);
  });

  it('rejects empty topic', () => {
    expect(JobInput.safeParse({ ...base, topic: '' }).success).toBe(false);
  });
});

describe('SourceInput', () => {
  it('accepts a URL descriptor', () => {
    const parsed = SourceInput.parse({ url: 'https://example.com/feed' });
    expect(parsed).toEqual({ url: 'https://example.com/feed' });
  });

  it('accepts a URL descriptor with hint and needsBrowser', () => {
    const parsed = SourceInput.parse({
      url: 'https://example.com/feed',
      hint: 'cf-protected',
      needsBrowser: true,
    });
    expect(parsed).toEqual({
      url: 'https://example.com/feed',
      hint: 'cf-protected',
      needsBrowser: true,
    });
  });

  it('accepts a search descriptor', () => {
    const parsed = SourceInput.parse({ search: 'rtx 5080 indirim turkiye' });
    expect(parsed).toEqual({ search: 'rtx 5080 indirim turkiye' });
  });

  it('accepts a search descriptor with hint', () => {
    const parsed = SourceInput.parse({ search: 'foo', hint: 'last week' });
    expect(parsed).toEqual({ search: 'foo', hint: 'last week' });
  });

  it('rejects an empty object', () => {
    expect(() => SourceInput.parse({})).toThrow();
  });

  it('rejects an object that is neither URL nor search', () => {
    expect(() => SourceInput.parse({ topic: 'nope' })).toThrow();
  });

  it('rejects a search of empty string', () => {
    expect(() => SourceInput.parse({ search: '' })).toThrow();
  });

  it('rejects a malformed URL', () => {
    expect(() => SourceInput.parse({ url: 'not a url' })).toThrow();
  });
});

describe('LoginInput / UserCreateInput', () => {
  it('LoginInput requires email + 8+ char password', () => {
    expect(LoginInput.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(false);
    expect(LoginInput.safeParse({ email: 'a@b.co', password: 'longenough' }).success).toBe(true);
  });
  it('UserCreateInput defaults isAdmin=false', () => {
    const u = UserCreateInput.parse({ email: 'a@b.co', password: 'longenough' });
    expect(u.isAdmin).toBe(false);
  });
});

describe('cron validation', () => {
  it('accepts a valid cron', () => {
    expect(validateCron('0 8 * * *').ok).toBe(true);
  });
  it('rejects a bad cron', () => {
    expect(validateCron('not a cron').ok).toBe(false);
  });
  it('returns a future Date for next fire', () => {
    const d = nextFireAt('0 8 * * *');
    expect(d).toBeInstanceOf(Date);
    expect(d!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('SourceBriefSchema', () => {
  it('accepts a minimal valid brief with empty items and empty errors', () => {
    const r = SourceBriefSchema.safeParse({
      source_url: 'https://example.com',
      items: [],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.fetch_errors).toEqual([]);
  });

  it('accepts a brief with up to 15 items and a fetch_errors entry', () => {
    const r = SourceBriefSchema.safeParse({
      source_url: 'https://example.com',
      items: [
        {
          title: 'A',
          url: 'https://example.com/a',
          summary: 'short summary',
          published_at: '2026-05-01',
        },
      ],
      fetch_errors: [{ code: 'blocked', detail: 'cloudflare interstitial' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects more than 15 items', () => {
    const items = Array.from({ length: 16 }, (_, i) => ({
      title: `T${i}`,
      url: `https://example.com/${i}`,
      summary: 's',
    }));
    const r = SourceBriefSchema.safeParse({ source_url: 'https://example.com', items });
    expect(r.success).toBe(false);
  });

  it('rejects summary longer than 800 chars', () => {
    const r = SourceBriefSchema.safeParse({
      source_url: 'https://example.com',
      items: [{ title: 'T', url: 'https://example.com/a', summary: 'x'.repeat(801) }],
    });
    expect(r.success).toBe(false);
  });
});
