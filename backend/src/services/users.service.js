// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: users (administration) and roles
//
// Decisions (flagged in the T20 PR):
//  - Unknown role ids on create/update: 422 `invalid_reference` (the same code the foreign key gives).
//  - Lock-out protection: an administrator cannot deactivate themselves or drop their own
//    `administrator` role, and the system can never be left without an active administrator.
//    The second rule is checked inside the transaction AFTER the change is applied, while the
//    active administrators are row-locked, so two administrators demoting each other at the same
//    time cannot both succeed.
//  - Passwords are hashed before the transaction opens (bcrypt cost 12 is slow) and are never
//    logged or returned; the audit trigger on `users` ignores password_hash.
import { query, queryOne, withTransaction } from '../db/query.js';
import { notFound, unprocessable } from '../middleware/errorHandler.js';
import { ROLES } from '../middleware/permissions.js';
import { hashPassword } from '../utils/passwordHash.js';

// Explicit columns: password_hash must never ride along.
const USER_SELECT = `
  SELECT u.user_id, u.full_name, u.email, u.active,
         COALESCE(array_agg(r.role_name ORDER BY r.role_name) FILTER (WHERE r.role_name IS NOT NULL), '{}') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.user_id
    LEFT JOIN roles r ON r.role_id = ur.role_id`;

// Whitelist: the sort key from the client picks one of these fixed strings, never reaches SQL as text.
const SORT_COLUMNS = { user_id: 'u.user_id', full_name: 'u.full_name', email: 'u.email' };

const toUser = (row) => ({
  user_id: row.user_id,
  full_name: row.full_name,
  email: row.email,
  roles: row.roles,
  active: row.active,
});

async function readUser(userId, executor) {
  const row = await queryOne(
    `${USER_SELECT} WHERE u.user_id = $1 GROUP BY u.user_id`,
    [userId],
    executor,
  );
  return row ? toUser(row) : null;
}

/** All roles, ordered by role_id. Not paginated: the lookup table holds six rows. */
export async function listRoles() {
  return query('SELECT role_id, role_name, description FROM roles ORDER BY role_id');
}

export async function listUsers({ active, role }, { limit, offset, sort }) {
  const filter = `
    WHERE ($1::boolean IS NULL OR u.active = $1::boolean)
      AND ($2::text IS NULL OR EXISTS (
            SELECT 1 FROM user_roles f JOIN roles fr ON fr.role_id = f.role_id
             WHERE f.user_id = u.user_id AND fr.role_name = $2::text))`;
  const params = [active ?? null, role ?? null];

  const orderColumn = SORT_COLUMNS[sort?.field] ?? 'u.user_id';
  const direction = sort?.direction === 'DESC' ? 'DESC' : 'ASC';
  const rows = await query(
    `${USER_SELECT} ${filter} GROUP BY u.user_id ORDER BY ${orderColumn} ${direction}, u.user_id LIMIT $3 OFFSET $4`,
    [...params, limit, offset],
  );
  const [{ total }] = await query(`SELECT count(*) AS total FROM users u ${filter}`, params);
  return { rows: rows.map(toUser), total };
}

/** Every id must exist in roles, otherwise 422 invalid_reference. */
async function assertRolesExist(roleIds, client) {
  const found = await query(
    'SELECT role_id FROM roles WHERE role_id = ANY($1::bigint[])',
    [roleIds],
    client,
  );
  const known = new Set(found.map((row) => row.role_id));
  const missing = roleIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw unprocessable(
      `Unknown role id(s): ${missing.join(', ')}`,
      [{ field: 'role_ids', message: `unknown role id(s): ${missing.join(', ')}` }],
      'invalid_reference',
    );
  }
}

export async function createUser({ full_name, email, password, role_ids }, actor) {
  const passwordHash = await hashPassword(password);
  return withTransaction(
    async (client) => {
      await assertRolesExist(role_ids, client);
      // uq_users_email is the authority on duplicates (409 `duplicate`), no check-then-insert.
      const [{ user_id: userId }] = await query(
        `INSERT INTO users (full_name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
        [full_name, email, passwordHash],
        client,
      );
      await query(
        `INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::bigint[])`,
        [userId, role_ids],
        client,
      );
      return readUser(userId, client);
    },
    { actorId: actor.user_id },
  );
}

const lockOut = (message, field) => unprocessable(message, [{ field, message }], 'rule_violation');

export async function updateUser(userId, body, actor) {
  const { active, full_name: fullName, role_ids: roleIds } = body;

  return withTransaction(
    async (client) => {
      // Lock the active administrators (stable order) so concurrent demotions serialize, then the target.
      await query(
        `SELECT u.user_id FROM users u
           JOIN user_roles ur ON ur.user_id = u.user_id
           JOIN roles r ON r.role_id = ur.role_id AND r.role_name = $1
          WHERE u.active ORDER BY u.user_id FOR UPDATE OF u`,
        [ROLES.ADMINISTRATOR],
        client,
      );
      const target = await queryOne(
        'SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE',
        [userId],
        client,
      );
      if (!target) throw notFound('User not found');

      if (roleIds) await assertRolesExist(roleIds, client);

      const before = await readUser(userId, client);
      const willBeAdmin = roleIds
        ? await queryOne(
            `SELECT 1 AS yes FROM roles WHERE role_id = ANY($1::bigint[]) AND role_name = $2`,
            [roleIds, ROLES.ADMINISTRATOR],
            client,
          )
        : before.roles.includes(ROLES.ADMINISTRATOR);

      if (userId === actor.user_id) {
        if (active === false) throw lockOut('You cannot deactivate your own account', 'active');
        if (roleIds && before.roles.includes(ROLES.ADMINISTRATOR) && !willBeAdmin) {
          throw lockOut('You cannot remove your own administrator role', 'role_ids');
        }
      }

      if (active !== undefined || fullName !== undefined) {
        await query(
          `UPDATE users
              SET active    = CASE WHEN $2::boolean THEN $3::boolean ELSE active END,
                  full_name = CASE WHEN $4::boolean THEN $5::text ELSE full_name END
            WHERE user_id = $1`,
          [userId, active !== undefined, active ?? null, fullName !== undefined, fullName ?? null],
          client,
        );
      }
      if (roleIds) {
        await query(
          'DELETE FROM user_roles WHERE user_id = $1 AND role_id <> ALL($2::bigint[])',
          [userId, roleIds],
          client,
        );
        await query(
          `INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::bigint[])
           ON CONFLICT (user_id, role_id) DO NOTHING`,
          [userId, roleIds],
          client,
        );
      }

      // Last active administrator: checked after the change, under the locks taken above.
      const [{ remaining }] = await query(
        `SELECT count(*) AS remaining FROM users u
           JOIN user_roles ur ON ur.user_id = u.user_id
           JOIN roles r ON r.role_id = ur.role_id AND r.role_name = $1
          WHERE u.active`,
        [ROLES.ADMINISTRATOR],
        client,
      );
      if (remaining === 0) {
        throw lockOut(
          'The last active administrator cannot be deactivated or lose the administrator role',
          active === false ? 'active' : 'role_ids',
        );
      }
      return readUser(userId, client);
    },
    { actorId: actor.user_id },
  );
}
