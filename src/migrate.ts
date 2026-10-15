import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { seedPermissionCatalog } from './permissions.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Applies pending SQL migrations (in filename order) exactly once each, then syncs the permission catalog. */
export async function migrate(log = true) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query(`SELECT name FROM schema_migrations`)).rows.map(r => r.name));
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); await c.query(`INSERT INTO schema_migrations(name) VALUES($1)`, [f]); await c.query('COMMIT'); if (log) console.log('applied', f); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  await seedPermissionCatalog(pool);
}
export async function resetDatabase() {   // tests / local dev only
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate(false);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().then(() => { console.log('migrations up to date'); return pool.end(); }).catch(e => { console.error(e); process.exit(1); });
}
