#!/usr/bin/env node
/*
 * One-time data import: copy a local SQLite/libSQL file into a Turso database.
 *
 * Usage:
 *   node scripts/import-to-turso.js <source-file> <dest-url> <dest-token>
 *
 * Example (production cutover):
 *   node scripts/import-to-turso.js ./fitness-prod.db \
 *     libsql://team-fitness-challenge-YOURORG.turso.io <PROD_TOKEN>
 *
 * Notes:
 *   - Dest URL + token are passed EXPLICITLY (never from .env) so you can't
 *     accidentally import into the dev database.
 *   - Re-runnable: it clears the dest tables first, then copies, preserving ids.
 */
const { createClient } = require('@libsql/client');

const [, , SOURCE, DEST_URL, DEST_TOKEN] = process.argv;
if (!SOURCE || !DEST_URL) {
  console.error('Usage: node scripts/import-to-turso.js <source-file> <dest-url> [dest-token]');
  process.exit(1);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    scoring_type TEXT NOT NULL,
    unit TEXT NOT NULL,
    challenge_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    challenge_id INTEGER NOT NULL,
    score_value REAL NOT NULL,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, challenge_id)
  );
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

// FK-safe order for inserts; reverse for deletes.
const TABLES = ['teams', 'users', 'challenges', 'scores'];

async function copyTable(src, dst, table) {
  const rs = await src.execute(`SELECT * FROM ${table}`);
  if (!rs.rows.length) return 0;
  const cols = rs.columns;
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  await dst.batch(rs.rows.map((r) => ({ sql, args: cols.map((c) => r[c]) })), 'write');
  return rs.rows.length;
}

(async () => {
  const src = createClient({ url: SOURCE.startsWith('file:') ? SOURCE : `file:${SOURCE}`, intMode: 'number' });
  const dst = createClient({ url: DEST_URL, authToken: DEST_TOKEN, intMode: 'number' });

  const host = DEST_URL.replace(/^libsql:\/\//, '').split(/[./]/)[0];
  console.log(`\nImporting  ${SOURCE}  →  ${host}\n`);

  // 1. Ensure schema exists on the destination.
  await dst.executeMultiple(SCHEMA);
  for (const [t, c] of [['users', 'team_id'], ['challenges', 'team_id']]) {
    const info = await dst.execute(`PRAGMA table_info(${t})`);
    if (!info.rows.some((r) => r.name === c)) await dst.execute(`ALTER TABLE ${t} ADD COLUMN ${c} INTEGER`);
  }

  // 2. Clear destination (reverse FK order) so the import is re-runnable.
  await dst.batch(['DELETE FROM scores', 'DELETE FROM challenges', 'DELETE FROM users', 'DELETE FROM teams'], 'write');

  // 3. Copy each table, preserving ids.
  console.log('Copying:');
  for (const t of TABLES) {
    const n = await copyTable(src, dst, t);
    console.log(`  ${t.padEnd(11)} ${n} rows`);
  }

  // 4. Verify destination counts.
  console.log('\nDestination row counts:');
  for (const t of TABLES) {
    const r = await dst.execute(`SELECT COUNT(*) AS n FROM ${t}`);
    console.log(`  ${t.padEnd(11)} ${r.rows[0].n}`);
  }
  console.log('\n✅ Import complete.\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ Import failed:', e.message, '\n');
  process.exit(1);
});
