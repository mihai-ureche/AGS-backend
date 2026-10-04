import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createStore } from './store.js';

const config = readConfig();
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 3000,
  statement_timeout: 5000,
  query_timeout: 6000,
});
pool.on('error', () => console.error('An idle database connection failed.'));

try {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
} catch {
  console.error('Database initialization failed. Check DATABASE_URL and database availability.');
  await pool.end();
  process.exit(1);
}

const app = createApp({ config, store: createStore(pool) });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`AGS support API listening on port ${config.port}`);
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  server.close(async () => {
    await pool.end();
    clearTimeout(deadline);
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
