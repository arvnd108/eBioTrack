// Owner: C (Testing & QA)
// Purpose: Completeness guard: every prepared statement and view must have its own query test block
//
// The inventory is read from the committed SQL: PREPARE names in database/queries/*_queries.sql and
// CREATE VIEW names in database/views/*.sql. A name is covered when a `describe(...)` title in the
// query suites contains it (a comment or a stray mention does not count). A future query or view
// fails this test until someone writes its block or adds it to ALLOWLIST below with a reason; the
// allowlist is code-reviewed and must stay short. Run with QUERY_REPORT=1 to print the table.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { preparedNames, queryFilePath, SLICES, VIEW_DIR, VIEW_NAMES } from '../setup/queries.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = SLICES.map((slice) => `${slice}.queries.test.js`);

// name -> reason. Nothing needs an exemption today.
const ALLOWLIST = new Map([]);

const suiteText = new Map(
  SUITES.map((file) => [file, readFileSync(path.join(here, file), 'utf8')]),
);
const describeTitles = (text) =>
  [...text.matchAll(/\bdescribe(?:\.\w+)?\(\s*(['"`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
const titles = new Map([...suiteText].map(([file, text]) => [file, describeTitles(text)]));
const mentions = (text, name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
const suitesCovering = (name) =>
  SUITES.filter((file) => titles.get(file).some((title) => mentions(title, name)));

function inventory() {
  const found = new Map();
  for (const slice of SLICES) {
    const text = readFileSync(queryFilePath(slice), 'utf8');
    for (const name of preparedNames(text)) found.set(name, `prepared statement (${slice})`);
  }
  for (const file of readdirSync(VIEW_DIR).filter((f) => f.endsWith('.sql'))) {
    const text = readFileSync(path.join(VIEW_DIR, file), 'utf8');
    for (const m of text.matchAll(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([a-z][a-z0-9_]*)/gim)) {
      found.set(m[1], `view (${file})`);
    }
  }
  return found;
}

describe('query coverage guard', () => {
  it('finds the queries and views it is supposed to guard (sanity)', () => {
    const names = inventory();
    for (const known of [
      'access_user_projects',
      'field_readings_moving_average',
      'q3_samples_with_qc_problems',
      'analysis_taxon_lineage',
      'v_failed_qc',
      'v_site_richness',
    ]) {
      expect(names.has(known), known).toBe(true);
    }
    expect([...names.values()].filter((k) => k.startsWith('view'))).toHaveLength(8);
    expect([...names.keys()].filter((n) => n.startsWith('v_')).sort()).toEqual(
      [...VIEW_NAMES].sort(),
    );
    expect(names.size).toBe(21);
  });

  it('every prepared statement and view has a describe block in a query suite or is allowlisted', () => {
    const names = inventory();
    const uncovered = [...names]
      .filter(([name]) => !ALLOWLIST.has(name) && suitesCovering(name).length === 0)
      .map(([name, kind]) => `${name} (${kind})`)
      .sort();
    expect(
      uncovered,
      `No query suite has a describe block for these:\n  ${uncovered.join('\n  ')}\n`,
    ).toEqual([]);
    if (process.env.QUERY_REPORT) {
      const rows = [...names]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([name, kind]) => `${name}\t${kind}\t${suitesCovering(name).join(', ') || 'ALLOWLIST'}`,
        );
      console.log(`name\tkind\tfile\n${rows.join('\n')}`);
    }
  });

  it('every allowlist entry names an existing query or view and carries a reason', () => {
    const names = inventory();
    for (const [name, reason] of ALLOWLIST) {
      expect(names.has(name), `allowlist entry ${name} no longer exists`).toBe(true);
      expect(reason.trim().length, `allowlist entry ${name} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('an allowlist entry that also has a describe block is stale (remove it)', () => {
    for (const name of ALLOWLIST.keys()) {
      expect(suitesCovering(name), `${name} is allowlisted but a suite covers it`).toEqual([]);
    }
  });

  it('no suite describes a name that is neither a query nor a view (typo guard)', () => {
    const names = inventory();
    for (const [file, list] of titles) {
      for (const title of list) {
        const m = title.match(/^[a-z]+: ([a-z][a-z0-9_]*)$/);
        if (m) expect(names.has(m[1]), `${file}: describe('${title}') matches nothing`).toBe(true);
      }
    }
  });
});
