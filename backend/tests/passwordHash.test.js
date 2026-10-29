// Owner: A (Backend)
// Purpose: Tests for hashPassword and verifyPassword
import { describe, expect, it } from 'vitest';
import { BCRYPT_COST, hashPassword, verifyPassword } from '../src/utils/passwordHash.js';

describe('passwordHash', () => {
  it('round-trips and uses cost 12 by default', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(BCRYPT_COST).toBe(12);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse', { cost: 4 });
    expect(await verifyPassword('battery staple', hash)).toBe(false);
  });

  it('lets tests lower the cost', async () => {
    expect(await hashPassword('x', { cost: 4 })).toMatch(/^\$2[aby]\$04\$/);
  });

  it('treats malformed input as a non-match instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword(undefined, '$2b$04$abc')).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });

  it('refuses to hash an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow(TypeError);
  });
});
