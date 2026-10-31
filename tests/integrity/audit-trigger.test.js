// Owner: C (Testing & QA)
// Purpose: Tests for the generic audit trigger audit_row_change() and its Access-slice attachments
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  closeTestPool,
  expectSqlState,
  getPool,
  reseed,
  setActingUser,
  withRollback,
} from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const auditFor = async (client, entityType, entityId) =>
  (
    await client.query(
      `SELECT audit_id, actor_id, entity_type, entity_id, action, details
         FROM audit_logs WHERE entity_type = $1 AND entity_id = $2 ORDER BY audit_id`,
      [entityType, entityId],
    )
  ).rows;
const auditCount = async (client) =>
  (await client.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n;

describe.skipIf(!dbAvailable)('audit_row_change()', () => {
  beforeAll(async () => {
    await reseed();
    // A schema reset drops the role grants; grants.sql is idempotent and needed for the role test.
    await getPool().query(readFileSync(path.join(root, 'database/roles/grants.sql'), 'utf8'));
  });
  afterAll(() => closeTestPool());

  it('is attached to the five Access tables and the log is empty after seeding', async () => {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT tgrelid::regclass::text AS tbl FROM pg_trigger
        WHERE tgname LIKE 'trg\\_%\\_audit' AND NOT tgisinternal ORDER BY 1`,
    );
    expect(rows.map((r) => r.tbl)).toEqual(
      expect.arrayContaining([
        'project_members',
        'project_sites',
        'projects',
        'user_roles',
        'users',
      ]),
    );
    expect((await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n).toBe(0);
  });

  it('reseed() leaves audit_logs empty and the next audit id is 1000', async () => {
    await reseed();
    await withRollback(async (client) => {
      expect(await auditCount(client)).toBe(0);
      await client.query(`INSERT INTO projects (title, created_by) VALUES ('Reseed probe', 2)`);
      const { rows } = await client.query('SELECT min(audit_id)::int AS id FROM audit_logs');
      expect(rows[0].id).toBe(1000);
    });
  });

  it('audits a project and a member insert with the acting user', async () => {
    await withRollback(async (client) => {
      await setActingUser(client, 1);
      const { rows } = await client.query(
        `INSERT INTO projects (title, objectives, created_by) VALUES ('Audit A', 'obj', 2) RETURNING project_id`,
      );
      const id = rows[0].project_id;
      await client.query(
        `INSERT INTO project_members (project_id, user_id, project_role) VALUES ($1, 3, 'viewer')`,
        [id],
      );
      const project = (await auditFor(client, 'projects', id)).filter((r) => r.action === 'insert');
      expect(project).toHaveLength(1);
      expect(project[0].actor_id).toBe('1');
      expect(project[0].details.title).toEqual({ new: 'Audit A' });
      expect(project[0].details.status).toEqual({ new: 'planned' });
      expect(project[0].details.objectives).toEqual({ new: 'obj' });
      const member = await auditFor(client, 'project_members', id);
      expect(member).toHaveLength(1);
      expect(member[0].details.user_id).toEqual({ new: 3 });
      expect(member[0].details.project_role).toEqual({ new: 'viewer' });
    });
  });

  it('create_project_with_owner() writes exactly two audit rows with the owner as actor', async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `SELECT create_project_with_owner('Audit B', 'o', NULL, 2) AS id`,
      );
      const id = rows[0].id;
      const all = await client.query(
        `SELECT entity_type, actor_id FROM audit_logs ORDER BY audit_id`,
      );
      expect(all.rows).toEqual([
        { entity_type: 'projects', actor_id: '2' },
        { entity_type: 'project_members', actor_id: '2' },
      ]);
      expect((await auditFor(client, 'project_members', id))[0].details.project_role).toEqual({
        new: 'owner',
      });
    });
  });

  it('logs only the changed columns of an update, and nothing for a no-op', async () => {
    await withRollback(async (client) => {
      await setActingUser(client, 1);
      await client.query(`UPDATE projects SET status = 'completed' WHERE project_id = 1`);
      const rows = await auditFor(client, 'projects', 1);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('update');
      expect(rows[0].details).toEqual({ status: { old: 'active', new: 'completed' } });
      await client.query(`UPDATE projects SET status = status WHERE project_id = 1`);
      expect(await auditFor(client, 'projects', 1)).toHaveLength(1);
    });
  });

  it('keeps users noise and secrets out of the log', async () => {
    await withRollback(async (client) => {
      await setActingUser(client, 1);
      const before = await auditCount(client);
      await client.query(`UPDATE users SET last_login_at = now() WHERE user_id = 3`);
      expect(await auditCount(client)).toBe(before);
      await client.query(`UPDATE users SET password_hash = 'x-new-hash' WHERE user_id = 3`);
      expect(await auditCount(client)).toBe(before);
      await client.query(`UPDATE users SET full_name = 'New Name' WHERE user_id = 3`);
      const rows = await auditFor(client, 'users', 3);
      expect(rows).toHaveLength(1);
      expect(rows[0].details).toEqual({ full_name: { old: 'Farah Field', new: 'New Name' } });

      const hash = '$2b$12$secretsecretsecretsecretsecretsecretsecretsecretsecretsecr';
      await client.query(
        `INSERT INTO users (full_name, email, password_hash) VALUES ('Probe', 'probe@ebiotrack.test', $1)`,
        [hash],
      );
      await client.query(
        `UPDATE users SET password_hash = $1 || 'z', full_name = 'Probe 2' WHERE email = 'probe@ebiotrack.test'`,
        [hash],
      );
      const leak = await client.query(
        `SELECT count(*)::int AS n FROM audit_logs WHERE details::text LIKE '%password_hash%' OR details::text LIKE '%secretsecret%'`,
      );
      expect(leak.rows[0].n).toBe(0);
    });
  });

  it('logs the full old row on delete, with the parent id as entity_id for link tables', async () => {
    await withRollback(async (client) => {
      await setActingUser(client, 1);
      await client.query(`DELETE FROM project_members WHERE project_id = 1 AND user_id = 6`);
      const rows = await auditFor(client, 'project_members', 1);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('delete');
      expect(Object.keys(rows[0].details).sort()).toEqual([
        'joined_at',
        'project_id',
        'project_role',
        'user_id',
      ]);
      expect(rows[0].details.project_role).toEqual({ old: 'viewer' });
    });
  });

  it('records a system action (NULL actor) when no acting user is set', async () => {
    await withRollback(async (client) => {
      await client.query(`UPDATE projects SET title = 'Renamed' WHERE project_id = 2`);
      expect((await auditFor(client, 'projects', 2))[0].actor_id).toBeNull();
    });
  });

  it('turns a malformed acting user into a warning, not a failed write', async () => {
    await withRollback(async (client) => {
      const warnings = [];
      client.on('notice', (n) => warnings.push(n.message));
      await client.query(`SELECT set_config('app.current_user_id', 'abc', true)`);
      await client.query(`UPDATE projects SET title = 'Renamed 2' WHERE project_id = 2`);
      const rows = await auditFor(client, 'projects', 2);
      expect(rows[0].actor_id).toBeNull();
      expect(warnings.some((m) => m.includes('abc'))).toBe(true);
    });
  });

  it('rejects an unknown acting user with 23503 and rolls the write back', async () => {
    await withRollback(async (client) => {
      await setActingUser(client, 99999);
      await expectSqlState(
        client.query(`UPDATE projects SET title = 'Renamed 3' WHERE project_id = 2`),
        '23503',
      );
    });
    await withRollback(async (client) => {
      const { rows } = await client.query(`SELECT title FROM projects WHERE project_id = 2`);
      expect(rows[0].title).toBe('Coastal Estuary Pilot');
    });
  });

  it('lets the app role insert audit rows but not rewrite history (42501)', async () => {
    await withRollback(async (client) => {
      await client.query('SET LOCAL ROLE ebiotrack_app');
      await setActingUser(client, 1);
      await client.query(`UPDATE projects SET title = 'By app' WHERE project_id = 2`);
      expect(await auditFor(client, 'projects', 2)).toHaveLength(1);
      await client.query('SAVEPOINT s');
      await expectSqlState(client.query(`UPDATE audit_logs SET action = 'delete'`), '42501');
      await client.query('ROLLBACK TO s');
      await expectSqlState(client.query('DELETE FROM audit_logs'), '42501');
    });
  });

  it('works on any table with a bigint key (scratch temp table) and names the table on misuse', async () => {
    await withRollback(async (client) => {
      await setActingUser(client, 1);
      await client.query('CREATE TEMP TABLE t (id bigint PRIMARY KEY, v text)');
      await client.query(
        `CREATE TRIGGER trg_t_audit AFTER INSERT OR UPDATE OR DELETE ON t
           FOR EACH ROW EXECUTE FUNCTION audit_row_change('id')`,
      );
      await client.query(`INSERT INTO t VALUES (7, 'a')`);
      await client.query(`UPDATE t SET v = 'b' WHERE id = 7`);
      await client.query(`UPDATE t SET v = NULL WHERE id = 7`);
      await client.query(`DELETE FROM t WHERE id = 7`);
      const { rows } = await client.query(
        `SELECT action, details FROM audit_logs WHERE entity_type = 't' AND entity_id = 7 ORDER BY audit_id`,
      );
      expect(rows.map((r) => r.action)).toEqual(['insert', 'update', 'update', 'delete']);
      expect(rows[0].details).toEqual({ id: { new: 7 }, v: { new: 'a' } });
      expect(rows[1].details).toEqual({ v: { old: 'a', new: 'b' } });
      expect(rows[2].details).toEqual({ v: { old: 'b', new: null } });
      expect(rows[3].details).toEqual({ id: { old: 7 }, v: { old: null } });
    });
    await withRollback(async (client) => {
      await client.query('CREATE TEMP TABLE bad (id bigint PRIMARY KEY, v text)');
      await client.query(
        `CREATE TRIGGER trg_bad_audit AFTER INSERT ON bad
           FOR EACH ROW EXECUTE FUNCTION audit_row_change('nope')`,
      );
      const err = await expectSqlState(client.query(`INSERT INTO bad VALUES (1, 'x')`), '22023');
      expect(err.message).toContain('bad');
    });
  });

  it('feeds the audit trail query: changed_fields is exactly the changed columns', async () => {
    const sql = readFileSync(path.join(root, 'database/queries/access_queries.sql'), 'utf8');
    const prepare = /PREPARE access_entity_audit_trail[\s\S]*?;\n/.exec(sql)[0];
    await withRollback(async (client) => {
      await setActingUser(client, 1);
      await client.query(
        `UPDATE projects SET status = 'completed', objectives = 'done' WHERE project_id = 1`,
      );
      await client.query(prepare);
      const { rows } = await client.query(
        `EXECUTE access_entity_audit_trail('projects', 1, NULL, NULL)`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].step_number).toBe('1');
      expect(rows[0].changed_fields).toEqual(['objectives', 'status']);
    });
  });
});
