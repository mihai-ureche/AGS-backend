import pg from 'pg';
import { UUID } from './config.js';
import { isRole } from './permissions.js';

// Operator-only command for initial administrator setup and account recovery.
// It deliberately requires an existing user ID and never guesses an account.
const [id, role, ...extra] = process.argv.slice(2);
const tenantId = process.env.MICROSOFT_TENANT_ID?.trim().toLowerCase();
if (!id || !UUID.test(id) || !isRole(role) || extra.length) {
  console.error('Usage: npm run user:role -- <database-user-uuid> <user|support|admin>');
  process.exit(1);
}
if (!tenantId || !UUID.test(tenantId) || !process.env.DATABASE_URL) {
  console.error('Set MICROSOFT_TENANT_ID and DATABASE_URL before assigning a role.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, query_timeout: 10000 });
try {
  await client.connect();
  const result = await client.query('UPDATE users SET role = $3, updated_at = NOW() WHERE tenant_id = $1 AND id = $2',
    [tenantId, id, role]);
  if (result.rowCount !== 1) {
    console.error('No user with that database ID exists in the configured organization.');
    process.exitCode = 1;
  } else {
    console.log(`Assigned role ${role} to user ${id}. It takes effect on their next API request.`);
  }
} catch {
  console.error('Role assignment failed. Check database access and start the updated backend to initialize the roles schema.');
  process.exitCode = 1;
} finally {
  await client.end();
}
