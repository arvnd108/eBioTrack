// Owner: A (Backend)
// Purpose: Tests for environment loading and validation
import { describe, expect, it } from 'vitest';
import { EnvError, loadConfig, maskDatabaseUrl } from '../src/config/env.js';

const DEV_URL = 'postgres://ebiotrack:change_me@localhost:5432/ebiotrack';
const TEST_URL = 'postgres://ebiotrack:change_me@localhost:5432/ebiotrack_test';
const valid = { DATABASE_URL: DEV_URL, TEST_DATABASE_URL: TEST_URL, SESSION_SECRET: 's3cret' };

describe('loadConfig', () => {
  it('applies defaults for PORT and NODE_ENV only', () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(4000);
    expect(config.nodeEnv).toBe('development');
    expect(config.databaseUrl).toBe(DEV_URL);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadConfig(valid))).toBe(true);
  });

  it('lists every missing variable in one clear message', () => {
    let error;
    try {
      loadConfig({});
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect(error.message).toContain('DATABASE_URL: is required');
    expect(error.message).toContain('SESSION_SECRET: is required');
  });

  it('rejects a non-integer PORT and a non-postgres URL', () => {
    expect(() => loadConfig({ ...valid, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'http://example.com/db' })).toThrow(
      /DATABASE_URL: must be a postgres/,
    );
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'not a url' })).toThrow(/DATABASE_URL/);
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...valid, PORT: '' }).port).toBe(4000);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('uses TEST_DATABASE_URL when NODE_ENV=test', () => {
    const config = loadConfig({ ...valid, NODE_ENV: 'test' });
    expect(config.databaseUrl).toBe(TEST_URL);
    expect(config.isTest).toBe(true);
  });

  it('never falls back to DATABASE_URL in test mode', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: DEV_URL, SESSION_SECRET: 's', NODE_ENV: 'test' }),
    ).toThrow(/TEST_DATABASE_URL: is required when NODE_ENV=test/);
    expect(() => loadConfig({ ...valid, NODE_ENV: 'test', TEST_DATABASE_URL: DEV_URL })).toThrow(
      /must differ from DATABASE_URL/,
    );
  });

  it('does not require DATABASE_URL in test mode', () => {
    const config = loadConfig({
      TEST_DATABASE_URL: TEST_URL,
      SESSION_SECRET: 's',
      NODE_ENV: 'test',
    });
    expect(config.databaseUrl).toBe(TEST_URL);
  });

  it('rejects the default secret in production', () => {
    expect(() =>
      loadConfig({ ...valid, SESSION_SECRET: 'change_me', NODE_ENV: 'production' }),
    ).toThrow(/SESSION_SECRET: must not be "change_me" in production/);
    expect(loadConfig({ ...valid, NODE_ENV: 'production' }).isProduction).toBe(true);
  });

  it('allows the default secret outside production', () => {
    expect(loadConfig({ ...valid, SESSION_SECRET: 'change_me' }).sessionSecret).toBe('change_me');
  });
});

describe('maskDatabaseUrl', () => {
  it('hides the password', () => {
    const masked = maskDatabaseUrl(DEV_URL);
    expect(masked).not.toContain('change_me');
    expect(masked).toContain('ebiotrack');
  });
});
