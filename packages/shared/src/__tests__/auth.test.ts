import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../auth.js';

describe('password hashing', () => {
  it('roundtrips a correct password', async () => {
    const hashed = await hashPassword('correct-horse-battery-staple');
    expect(hashed).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword('correct-horse-battery-staple', hashed)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hashed = await hashPassword('hunter2-hunter2');
    expect(await verifyPassword('nope', hashed)).toBe(false);
  });

  it('returns false on garbage hash rather than throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});
