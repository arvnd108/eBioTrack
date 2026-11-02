// Owner: C (Testing & QA)
// Purpose: Completeness guard: every constraint, unique index and trigger must be named in a test
//
// A future migration that adds a pk_/fk_/uq_/ck_ constraint, a uq_ unique index or a trigger fails
// this test until someone writes a case that mentions its name in one of the integrity suites (or
// adds it to ALLOWLIST below with a reason; the allowlist is code-reviewed and must stay short).
// Run with INTEGRITY_REPORT=1 to print the "name -> test file" table.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { closeTestPool, getPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');
const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  'access.integrity.test.js',
  'field.integrity.test.js',
  'lab.integrity.test.js',
  'analysis.integrity.test.js',
  'audit-trigger.test.js',
];

// name -> reason. Nothing needs an exemption today: even the session store's primary key
// (pk_session) and the triggers of every slice are exercised by name.
const ALLOWLIST = new Map([]);

const suiteText = new Map(
  SUITES.map((file) => [file, readFileSync(path.join(here, file), 'utf8')]),
);
const mentions = (text, name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
const suitesNaming = (name) => SUITES.filter((file) => mentions(suiteText.get(file), name));

async function catalogNames() {
  const db = getPool();
  const constraints = await db.query(
    `SELECT c.conname AS name, 'constraint' AS kind
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.conname ~ '^(pk|fk|uq|ck)_'`,
  );
  const indexes = await db.query(
    `SELECT indexname AS name, 'unique index' AS kind FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE 'uq\\_%'`,
  );
  const triggers = await db.query(
    `SELECT t.tgname AS name, 'trigger' AS kind
       FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  );
  const byName = new Map();
  for (const row of [...constraints.rows, ...indexes.rows, ...triggers.rows]) {
    byName.set(row.name, byName.get(row.name) ?? row.kind);
  }
  return byName;
}

describe.skipIf(!dbAvailable)('constraint coverage guard', () => {
  afterAll(() => closeTestPool());

  it('finds the schema objects it is supposed to guard (sanity)', async () => {
    const names = await catalogNames();
    for (const known of [
      'pk_users',
      'uq_project_members_owner',
      'fk_collection_events_project_site',
      'ck_analysis_runs_approved_fields',
      'trg_samples_status_transition',
      'trg_analysis_runs_immutable',
    ]) {
      expect(names.has(known)).toBe(true);
    }
    expect(names.size).toBeGreaterThan(100);
  });

  it('every constraint, unique index and trigger is named in an integrity suite or allowlisted', async () => {
    const names = await catalogNames();
    const uncovered = [...names]
      .filter(([name]) => !ALLOWLIST.has(name) && suitesNaming(name).length === 0)
      .map(([name, kind]) => `${name} (${kind})`)
      .sort();
    expect(
      uncovered,
      `No integrity test names these objects:\n  ${uncovered.join('\n  ')}\n`,
    ).toEqual([]);
    if (process.env.INTEGRITY_REPORT) {
      const rows = [...names]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, kind]) => `${name}\t${kind}\t${suitesNaming(name).join(', ') || 'ALLOWLIST'}`);
      console.log(`name\tkind\tfile\n${rows.join('\n')}`);
    }
  });

  it('every allowlist entry names an object that exists and carries a reason', async () => {
    const names = await catalogNames();
    for (const [name, reason] of ALLOWLIST) {
      expect(names.has(name), `allowlist entry ${name} no longer exists in the schema`).toBe(true);
      expect(reason.trim().length, `allowlist entry ${name} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('an allowlist entry that is also named in a test is stale (remove it)', () => {
    for (const name of ALLOWLIST.keys()) {
      expect(suitesNaming(name), `${name} is allowlisted but a test names it`).toEqual([]);
    }
  });
});
