const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const fs = require('fs').promises;
const path = require('path');

const app = express();
let db = null;

// Database file path
const DB_PATH = process.env.RENDER ? '/var/data/fitness.db' : './fitness.db';
const IS_RENDER = !!process.env.RENDER;

async function loadDatabase() {
  const SQL = await initSqlJs();

  try {
    const fileBuffer = await fs.readFile(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log(`Loaded existing database from ${DB_PATH}`);
  } catch (err) {
    db = new SQL.Database();
    console.log('Created new database');
  }

  // Always ensure the schema is up to date (creates tables/columns if missing).
  ensureSchema();
}

// ---- Schema + idempotent migrations (safe to run on an existing DB) ----
function hasColumn(table, col) {
  const res = db.exec(`PRAGMA table_info(${table})`);
  if (!res.length) return false;
  return res[0].values.some((row) => row[1] === col); // row[1] = column name
}

function ensureSchema() {
  db.run(`
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
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (challenge_id) REFERENCES challenges(id),
      UNIQUE(user_id, challenge_id)
    );
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrations: add team association columns if they don't exist yet.
  if (!hasColumn('users', 'team_id')) db.run('ALTER TABLE users ADD COLUMN team_id INTEGER');
  if (!hasColumn('challenges', 'team_id')) db.run('ALTER TABLE challenges ADD COLUMN team_id INTEGER');

  // Ensure a default admin exists.
  const stmt = db.prepare("SELECT COUNT(*) as count FROM users WHERE username = 'admin'");
  stmt.step();
  const result = stmt.getAsObject();
  stmt.free();
  if (result.count === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)', ['admin', hash]);
    console.log('Default admin created — username: admin, password: admin123');
  }
}

// ---- Persistence: atomic, non-overlapping saves ----
// Writes the current in-memory DB to disk atomically (temp file + rename).
async function writeDbToDisk() {
  const buffer = Buffer.from(db.export());
  const dirPath = path.dirname(DB_PATH);
  try { await fs.mkdir(dirPath, { recursive: true }); } catch (e) { /* exists */ }
  const tmp = `${DB_PATH}.tmp`;
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, DB_PATH); // atomic swap on same filesystem
}

let saving = false;
let saveQueued = false;
async function saveDatabase() {
  if (!db) return;
  if (saving) { saveQueued = true; return; }
  saving = true;
  try {
    await writeDbToDisk();
  } catch (err) {
    console.error('Failed to save database:', err.message);
  } finally {
    saving = false;
    if (saveQueued) { saveQueued = false; saveDatabase(); }
  }
}

// Guaranteed final flush for shutdown: waits out any in-flight save, then writes
// the latest state directly so the most recent change can't be lost on restart.
async function flushDatabase() {
  if (!db) return;
  while (saving) { await new Promise((r) => setTimeout(r, 20)); }
  try { await writeDbToDisk(); } catch (err) { console.error('Failed to flush database:', err.message); }
}

// ========== Query helpers ==========
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length ? rows[0] : null;
}

// ========== Middleware Setup ==========
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fitness-secret-key-change-on-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Re-hydrate the session user from the DB each request so role/team/username
// changes take effect immediately, and expose template locals.
app.use((req, res, next) => {
  if (req.session.user) {
    const u = queryOne('SELECT id, username, is_admin, team_id FROM users WHERE id = ?', [req.session.user.id]);
    if (u) {
      req.session.user = { id: u.id, username: u.username, is_admin: !!u.is_admin, team_id: u.team_id ?? null };
    } else {
      req.session.user = null; // account was deleted
    }
  }
  res.locals.user = req.session.user || null;
  res.locals.activeTeam = req.session.activeTeam || 'all';
  res.locals.teams = db ? queryAll('SELECT id, name FROM teams ORDER BY name') : [];
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) return res.redirect('/');
  next();
}

// ========== Team scoping helpers ==========
// Determine which team the current request is scoped to.
//   admins: follow their session "active team" toggle ('all' = everything)
//   players: always locked to their own team
function scopeFor(req) {
  const user = req.session.user;
  if (user.is_admin) {
    const at = req.session.activeTeam;
    if (!at || at === 'all') return { all: true, teamId: null };
    return { all: false, teamId: parseInt(at, 10) };
  }
  return { all: false, teamId: user.team_id != null ? user.team_id : null };
}

function scopeName(scope) {
  if (scope.all) return 'All Teams';
  if (scope.teamId == null) return 'Unassigned';
  const t = queryOne('SELECT name FROM teams WHERE id = ?', [scope.teamId]);
  return t ? t.name : 'Team';
}

// WHERE fragment restricting *challenges* to the scope.
// A challenge with team_id = NULL is global (visible to every team).
function challengeTeamClause(scope, alias) {
  const col = alias ? `${alias}.team_id` : 'team_id';
  if (scope.all) return { sql: '', params: [] };
  if (scope.teamId == null) return { sql: ` AND ${col} IS NULL`, params: [] };
  return { sql: ` AND (${col} IS NULL OR ${col} = ?)`, params: [scope.teamId] };
}

// WHERE fragment restricting *users* to the scope.
function userTeamClause(scope, alias) {
  const col = alias ? `${alias}.team_id` : 'team_id';
  if (scope.all) return { sql: '', params: [] };
  if (scope.teamId == null) return { sql: ` AND ${col} IS NULL`, params: [] };
  return { sql: ` AND ${col} = ?`, params: [scope.teamId] };
}

function calculatePoints(scores, scoringType) {
  const sorted = [...scores].sort((a, b) =>
    scoringType === 'min_time' ? a.score_value - b.score_value : b.score_value - a.score_value
  );
  const pointsMap = [10, 8, 6, 5, 4, 3, 2, 1];
  return sorted.map((entry, i) => ({ ...entry, rank: i + 1, points: i < pointsMap.length ? pointsMap[i] : 1 }));
}

// ========== Routes ==========

// Home Dashboard
app.get('/', requireAuth, (req, res) => {
  const scope = scopeFor(req);
  const today = new Date().toISOString().split('T')[0];

  const tc = challengeTeamClause(scope, null);
  const todayChallenge = queryOne(
    `SELECT * FROM challenges WHERE challenge_date = ?${tc.sql} ORDER BY created_at DESC LIMIT 1`,
    [today, ...tc.params]
  );

  let userScore = null, participants = 0;
  if (todayChallenge) {
    userScore = queryOne('SELECT * FROM scores WHERE user_id = ? AND challenge_id = ?', [req.session.user.id, todayChallenge.id]);
    const p = queryOne('SELECT COUNT(DISTINCT user_id) as count FROM scores WHERE challenge_id = ?', [todayChallenge.id]);
    participants = p ? p.count : 0;
  }

  const rc = challengeTeamClause(scope, 'c');
  const recentChallenges = queryAll(
    `SELECT c.*, COUNT(s.id) as score_count FROM challenges c LEFT JOIN scores s ON c.id = s.challenge_id
     WHERE 1=1${rc.sql} GROUP BY c.id ORDER BY c.challenge_date DESC LIMIT 5`,
    rc.params
  );

  res.render('dashboard', { todayChallenge, userScore, participants, recentChallenges, teamName: scopeName(scope) });
});

// Login/Register
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = queryOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Invalid credentials' });
  }
  req.session.user = { id: user.id, username: user.username, is_admin: !!user.is_admin, team_id: user.team_id ?? null };
  res.redirect('/');
});

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.render('register', { error: 'Username 3+ chars, password 4+ chars' });
  }
  if (queryOne('SELECT id FROM users WHERE username = ?', [username])) {
    return res.render('register', { error: 'Username taken' });
  }
  // Player picks their own team at signup; only accept a real team id.
  let teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (teamId != null && !queryOne('SELECT id FROM teams WHERE id = ?', [teamId])) teamId = null;
  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (username, password_hash, team_id) VALUES (?, ?, ?)', [username, hash, teamId]);
  const lastId = db.exec('SELECT last_insert_rowid() as id')[0]?.values?.[0]?.[0] || 0;
  saveDatabase();
  req.session.user = { id: lastId, username, is_admin: false, team_id: teamId };
  res.redirect('/');
});

app.post('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// Admin team toggle
app.post('/set-team', requireAdmin, (req, res) => {
  const t = req.body.team;
  req.session.activeTeam = (!t || t === 'all') ? 'all' : t;
  res.redirect(req.get('referer') || '/');
});

// Challenge View & Submit
app.get('/challenge/:id', requireAuth, (req, res) => {
  const scope = scopeFor(req);
  const challenge = queryOne(
    'SELECT c.*, t.name AS team_name FROM challenges c LEFT JOIN teams t ON c.team_id = t.id WHERE c.id = ?',
    [req.params.id]
  );
  if (!challenge) return res.redirect('/');
  // Block viewing another team's challenge.
  if (!scope.all && challenge.team_id != null && challenge.team_id !== scope.teamId) return res.redirect('/');

  const myScore = queryOne('SELECT * FROM scores WHERE user_id = ? AND challenge_id = ?', [req.session.user.id, challenge.id]);

  const utc = userTeamClause(scope, 'u');
  const allScores = queryAll(
    `SELECT s.*, u.username FROM scores s JOIN users u ON s.user_id = u.id
     WHERE s.challenge_id = ?${utc.sql} ORDER BY s.submitted_at ASC`,
    [challenge.id, ...utc.params]
  );

  const rankedScores = calculatePoints(allScores, challenge.scoring_type);
  res.render('challenge', { challenge, myScore, rankedScores });
});

app.post('/challenge/:id/submit', requireAuth, (req, res) => {
  const scope = scopeFor(req);
  const challenge = queryOne('SELECT * FROM challenges WHERE id = ?', [req.params.id]);
  if (!challenge) return res.redirect('/');
  if (!scope.all && challenge.team_id != null && challenge.team_id !== scope.teamId) return res.redirect('/');

  const scoreValue = parseFloat(req.body.scoreValue);
  if (isNaN(scoreValue) || scoreValue < 0) return res.status(400).send('Invalid score');

  db.run(
    "INSERT OR REPLACE INTO scores (user_id, challenge_id, score_value, submitted_at) VALUES (?, ?, ?, datetime('now'))",
    [req.session.user.id, challenge.id, scoreValue]
  );
  saveDatabase();
  res.redirect(`/challenge/${challenge.id}`);
});

// Leaderboard
app.get('/leaderboard', requireAuth, (req, res) => {
  const scope = scopeFor(req);
  const period = req.query.period || 'all';
  let dateFilter = '';
  if (period === 'week') dateFilter = "AND c.challenge_date >= date('now', '-7 days')";
  else if (period === 'month') dateFilter = "AND c.challenge_date >= date('now', '-30 days')";

  const ctc = challengeTeamClause(scope, 'c');
  const utc = userTeamClause(scope, 'u');
  const allScores = queryAll(
    `SELECT s.user_id, u.username, s.score_value, s.challenge_id, c.scoring_type, c.title, c.category
     FROM scores s JOIN users u ON s.user_id = u.id JOIN challenges c ON s.challenge_id = c.id
     WHERE 1=1 ${dateFilter}${ctc.sql}${utc.sql}`,
    [...ctc.params, ...utc.params]
  );

  const challengesMap = {};
  for (const row of allScores) {
    if (!challengesMap[row.challenge_id]) challengesMap[row.challenge_id] = [];
    challengesMap[row.challenge_id].push(row);
  }

  const userTotals = {};
  for (const cid in challengesMap) {
    const ranked = calculatePoints(challengesMap[cid], challengesMap[cid][0].scoring_type);
    for (const entry of ranked) {
      if (!userTotals[entry.user_id]) userTotals[entry.user_id] = { username: entry.username, totalPoints: 0, challengesDone: 0, topFinishes: { '1st': 0, '2nd': 0, '3rd': 0 } };
      userTotals[entry.user_id].totalPoints += entry.points;
      userTotals[entry.user_id].challengesDone++;
      if (entry.rank === 1) userTotals[entry.user_id].topFinishes['1st']++;
      if (entry.rank === 2) userTotals[entry.user_id].topFinishes['2nd']++;
      if (entry.rank === 3) userTotals[entry.user_id].topFinishes['3rd']++;
    }
  }

  const leaderboard = Object.values(userTotals).sort((a, b) => b.totalPoints - a.totalPoints).map((e, i) => ({ ...e, rank: i + 1 }));

  const clc = challengeTeamClause(scope, 'c');
  const challengesList = queryAll(
    `SELECT c.id, c.title, c.category, c.scoring_type, c.challenge_date FROM challenges c
     WHERE 1=1 ${dateFilter}${clc.sql} ORDER BY c.challenge_date DESC`,
    clc.params
  );

  res.render('leaderboard', { leaderboard, period, challengesList, teamName: scopeName(scope) });
});

// ========== Admin Panel ==========
app.get('/admin', requireAdmin, (req, res) => {
  const challenges = queryAll(
    `SELECT c.*, t.name AS team_name FROM challenges c LEFT JOIN teams t ON c.team_id = t.id
     ORDER BY c.challenge_date DESC, c.created_at DESC`
  );
  const users = queryAll(
    `SELECT u.id, u.username, u.is_admin, u.team_id, t.name AS team_name
     FROM users u LEFT JOIN teams t ON u.team_id = t.id ORDER BY u.username`
  );
  const teams = queryAll(
    `SELECT tm.id, tm.name,
       (SELECT COUNT(*) FROM users u2 WHERE u2.team_id = tm.id) AS member_count,
       (SELECT COUNT(*) FROM challenges c2 WHERE c2.team_id = tm.id) AS challenge_count
     FROM teams tm ORDER BY tm.name`
  );
  res.render('admin', { challenges, users, teams, currentUserId: req.session.user.id });
});

// --- Challenges ---
app.post('/admin/create-challenge', requireAdmin, (req, res) => {
  const { title, description, category, scoringType, unit, challengeDate } = req.body;
  const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (!title || !category || !scoringType || !unit || !challengeDate) return res.status(400).send('Missing fields');
  db.run(
    'INSERT INTO challenges (title, description, category, scoring_type, unit, challenge_date, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title, description || '', category, scoringType, unit, challengeDate, teamId]
  );
  saveDatabase();
  res.redirect('/admin');
});

// Quick inline team reassignment.
app.post('/admin/edit-challenge/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (!queryOne('SELECT id FROM challenges WHERE id = ?', [id])) return res.redirect('/admin');
  db.run('UPDATE challenges SET team_id = ? WHERE id = ?', [teamId, id]);
  saveDatabase();
  res.redirect('/admin');
});

// Full challenge edit (title, description, category, scoring, unit, date, team).
app.post('/admin/update-challenge/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!queryOne('SELECT id FROM challenges WHERE id = ?', [id])) return res.redirect('/admin');
  const { title, description, category, scoringType, unit, challengeDate } = req.body;
  const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (!title || !category || !scoringType || !unit || !challengeDate) return res.status(400).send('Missing fields');
  db.run(
    'UPDATE challenges SET title = ?, description = ?, category = ?, scoring_type = ?, unit = ?, challenge_date = ?, team_id = ? WHERE id = ?',
    [title, description || '', category, scoringType, unit, challengeDate, teamId, id]
  );
  saveDatabase();
  res.redirect('/admin');
});

app.post('/admin/delete-challenge/:id', requireAdmin, (req, res) => {
  db.run('DELETE FROM scores WHERE challenge_id = ?', [req.params.id]);
  db.run('DELETE FROM challenges WHERE id = ?', [req.params.id]);
  saveDatabase();
  res.redirect('/admin');
});

// --- Users ---
app.post('/admin/create-user', requireAdmin, (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const isAdmin = req.body.is_admin ? 1 : 0;
  const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (username.length < 3 || password.length < 4) return res.status(400).send('Username must be 3+ chars and password 4+ chars');
  if (queryOne('SELECT id FROM users WHERE username = ?', [username])) return res.status(400).send('Username taken');
  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (username, password_hash, is_admin, team_id) VALUES (?, ?, ?, ?)', [username, hash, isAdmin, teamId]);
  saveDatabase();
  res.redirect('/admin');
});

app.post('/admin/edit-user/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const username = (req.body.username || '').trim();
  let isAdmin = req.body.is_admin ? 1 : 0;
  const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (username.length < 3) return res.status(400).send('Username must be 3+ chars');
  if (queryOne('SELECT id FROM users WHERE username = ? AND id != ?', [username, id])) return res.status(400).send('Username taken');
  // Don't let an admin lock themselves out by removing their own admin rights.
  if (id === req.session.user.id) isAdmin = 1;
  db.run('UPDATE users SET username = ?, is_admin = ?, team_id = ? WHERE id = ?', [username, isAdmin, teamId, id]);
  saveDatabase();
  res.redirect('/admin');
});

app.post('/admin/delete-user/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.user.id) return res.redirect('/admin'); // can't delete yourself
  db.run('DELETE FROM scores WHERE user_id = ?', [id]);
  db.run('DELETE FROM users WHERE id = ?', [id]);
  saveDatabase();
  res.redirect('/admin');
});

app.post('/admin/reset-password/:id', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).send('Password must be at least 4 characters');
  if (!queryOne('SELECT id FROM users WHERE id = ?', [req.params.id])) return res.redirect('/admin');
  const hash = bcrypt.hashSync(newPassword, 10);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
  saveDatabase();
  res.redirect('/admin');
});

// --- Teams ---
app.post('/admin/create-team', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin');
  if (!queryOne('SELECT id FROM teams WHERE name = ?', [name])) {
    db.run('INSERT INTO teams (name) VALUES (?)', [name]);
    saveDatabase();
  }
  res.redirect('/admin');
});

app.post('/admin/rename-team/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin');
  if (queryOne('SELECT id FROM teams WHERE name = ? AND id != ?', [name, id])) return res.status(400).send('Team name taken');
  db.run('UPDATE teams SET name = ? WHERE id = ?', [name, id]);
  saveDatabase();
  res.redirect('/admin');
});

app.post('/admin/delete-team/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Unassign members and make its challenges global rather than orphaning them.
  db.run('UPDATE users SET team_id = NULL WHERE team_id = ?', [id]);
  db.run('UPDATE challenges SET team_id = NULL WHERE team_id = ?', [id]);
  db.run('DELETE FROM teams WHERE id = ?', [id]);
  saveDatabase();
  res.redirect('/admin');
});

// Change Password (self-service)
app.get('/change-password', requireAuth, (req, res) => res.render('change-password', { error: null, success: null }));
app.post('/change-password', (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const userData = queryOne('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
  if (!userData || !bcrypt.compareSync(currentPassword, userData.password_hash)) {
    return res.render('change-password', { error: 'Current password incorrect', success: null });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.render('change-password', { error: 'Min 4 characters required', success: null });
  }
  if (newPassword !== confirmPassword) {
    return res.render('change-password', { error: 'Passwords do not match', success: null });
  }
  if (newPassword === currentPassword) {
    return res.render('change-password', { error: 'Must be different', success: null });
  }
  const newHash = bcrypt.hashSync(newPassword, 10);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.session.user.id]);
  saveDatabase();
  res.render('change-password', { error: null, success: 'Password updated!' });
});

// ========== Error handling ==========
// Any error thrown in a (synchronous) route lands here -> clean 500 instead of
// crashing the whole process and taking the site down.
app.use((err, req, res, next) => {
  console.error('Route error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).send('Something went wrong. Please try again.');
});

// Last-resort guards so an unexpected async error never kills the server.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

// ========== Graceful Shutdown ==========
async function shutdown() {
  console.log('\nShutting down... Saving database.');
  await flushDatabase();
  console.log('Goodbye!');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ========== Start Server ==========
const PORT = process.env.PORT || 3000;

loadDatabase().then(() => {
  console.log(`Starting server on port ${PORT}...`);
  app.listen(PORT, () => {
    console.log(`🚀 Running on port ${PORT}`);
    console.log(`${IS_RENDER ? '⚠️ RENDER MODE: Data persists to /var/data/fitness.db' : '💾 LOCAL MODE: Data saves to ./fitness.db'}`);
  });
  // Periodic backstop save (in addition to save-after-mutation + shutdown save).
  setInterval(saveDatabase, 5 * 60 * 1000);
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
