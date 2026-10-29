// Owner: A (Backend)
// Purpose: Unit tests for the in-memory failed sign-in limiter
import { describe, expect, it } from 'vitest';
import { createLoginAttempts } from '../src/utils/loginAttempts.js';

describe('createLoginAttempts', () => {
  it('blocks a key after the threshold and frees it when the window ends', () => {
    let now = 0;
    const limiter = createLoginAttempts({ maxFailures: 3, windowMs: 1000, now: () => now });
    for (let i = 0; i < 2; i++) limiter.recordFailure('a');
    expect(limiter.retryAfterSeconds('a')).toBe(0);
    limiter.recordFailure('a');
    expect(limiter.retryAfterSeconds('a')).toBe(1);
    expect(limiter.retryAfterSeconds('b')).toBe(0);
    now = 1000;
    expect(limiter.retryAfterSeconds('a')).toBe(0);
  });

  it('forgets a key on reset', () => {
    const limiter = createLoginAttempts({ maxFailures: 1 });
    limiter.recordFailure('a');
    limiter.reset('a');
    expect(limiter.retryAfterSeconds('a')).toBe(0);
  });
});
