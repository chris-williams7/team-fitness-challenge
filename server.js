require('dotenv').config({ path: ['.env.local', '.env'] });
const express = require('express');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const path = require('path');

const app = express();

// ========== Database (libSQL / Turso) ==========
// Prod + dev both point at a Turso database via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
// (keep dev credentials in a gitignored .env). With no env set, falls back to a local
// libSQL file so the app can still boot offline / in CI.
const DB_URL = process.env.TURSO_DATABASE_URL
  || (process.env.NODE_ENV === 'production' ? null : 'file:fitness-dev.db');
if (!DB_URL) {
  console.error('TURSO_DATABASE_URL is required in production. Refusing to start.');
  process.exit(1);
}
const client = createClient({
  url: DB_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  intMode: 'number', // return SQLite INTEGERs as JS numbers (matches prior behavior)
});

// Wrap async route handlers so rejected promises become clean 500s, not crashes.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---- Query helpers (async) ----
async function queryAll(sql, args = []) {
  const rs = await client.execute({ sql, args });
  const cols = rs.columns;
  return rs.rows.map((row) => {
    const o = {};
    for (const c of cols) o[c] = row[c];
    return o;
  });
}
async function queryOne(sql, args = []) {
  const rows = await queryAll(sql, args);
  return rows.length ? rows[0] : null;
}
async function run(sql, args = []) {
  return client.execute({ sql, args });
}

// ---- Schema + idempotent migrations ----
async function hasColumn(table, col) {
  const rs = await client.execute(`PRAGMA table_info(${table})`);
  return rs.rows.some((r) => r.name === col);
}

async function ensureSchema() {
  await client.executeMultiple(`
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
  `);

  if (!(await hasColumn('users', 'team_id'))) await run('ALTER TABLE users ADD COLUMN team_id INTEGER');
  if (!(await hasColumn('challenges', 'team_id'))) await run('ALTER TABLE challenges ADD COLUMN team_id INTEGER');

  const c = await queryOne("SELECT COUNT(*) as count FROM users WHERE username = 'admin'");
  if (c.count === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await run('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)', ['admin', hash]);
    console.log('Default admin created — username: admin, password: admin123');
  }
}

// ========== Middleware ==========
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Stateless signed-cookie sessions — no server-side store, so cluster nodes share
// sessions as long as they share SESSION_SECRET.
app.use(cookieSession({
  name: 'tfc_session',
  keys: [process.env.SESSION_SECRET || 'fitness-secret-key-change-on-prod'],
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
}));

// Re-hydrate the user from the DB each request so role/team/username changes take
// effect immediately, and expose template locals.
app.use(wrap(async (req, res, next) => {
  if (req.session && req.session.user) {
    const u = await queryOne('SELECT id, username, is_admin, team_id FROM users WHERE id = ?', [req.session.user.id]);
    if (u) {
      req.session.user = { id: u.id, username: u.username, is_admin: !!u.is_admin, team_id: u.team_id ?? null };
    } else {
      req.session = null; // account was deleted
    }
  }
  res.locals.user = (req.session && req.session.user) || null;
  res.locals.activeTeam = (req.session && req.session.activeTeam) || 'all';
  res.locals.teams = await queryAll('SELECT id, name FROM teams ORDER BY name');
  res.locals.linkify = linkify;
  res.locals.formatScore = formatScore;
  next();
}));

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.is_admin) return res.redirect('/');
  next();
}

// ========== Presentation helpers ==========
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function linkify(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/((?:https?:\/\/|www\.)[^\s<]+)/g, (match) => {
    const trail = (match.match(/[.,!?)\]]+$/) || [''])[0];
    const url = match.slice(0, match.length - trail.length);
    const href = url.startsWith('www.') ? `https://${url}` : url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });
}
// Display a stored score. Fastest-time challenges store total seconds but show m:ss.
function formatScore(value, scoringType, unit) {
  if (scoringType !== 'min_time') return `${value} ${unit}`;
  const total = Math.max(0, Number(value) || 0);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const intPart = Math.floor(s);
  const secStr = (intPart < 10 ? '0' : '') + (Number.isInteger(s) ? String(intPart) : String(s));
  return `${m}:${secStr}`;
}

// ========== Team scoping helpers ==========
function scopeFor(req) {
  const user = req.session.user;
  if (user.is_admin) {
    const at = req.session.activeTeam;
    if (!at || at === 'all') return { all: true, teamId: null };
    return { all: false, teamId: parseInt(at, 10) };
  }
  return { all: false, teamId: user.team_id != null ? user.team_id : null };
}
async function scopeName(scope) {
  if (scope.all) return 'All Teams';
  if (scope.teamId == null) return 'Unassigned';
  const t = await queryOne('SELECT name FROM teams WHERE id = ?', [scope.teamId]);
  return t ? t.name : 'Team';
}
function challengeTeamClause(scope, alias) {
  const col = alias ? `${alias}.team_id` : 'team_id';
  if (scope.all) return { sql: '', params: [] };
  if (scope.teamId == null) return { sql: ` AND ${col} IS NULL`, params: [] };
  return { sql: ` AND (${col} IS NULL OR ${col} = ?)`, params: [scope.teamId] };
}
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
  const pointsAt = (i) => (i < pointsMap.length ? pointsMap[i] : 1);
  const result = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].score_value === sorted[i].score_value) j++;
    const rank = i + 1;
    const points = pointsAt(i);
    const tied = (j - i) > 1;
    for (let k = i; k < j; k++) result.push({ ...sorted[k], rank, points, tied });
    i = j;
  }
  return result;
}

// ========== Date helpers ==========
// "Today" is computed in the team's local timezone (set TIMEZONE in the environment)
// so the day rolls over at local midnight rather than UTC midnight.
const APP_TZ = process.env.TIMEZONE || 'America/New_York';
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ }); // YYYY-MM-DD
}
function isChallengeOpen(challenge, today = todayStr()) {
  return challenge.challenge_date <= today;
}

// ========== Routes ==========

// Home Dashboard
app.get('/', requireAuth, wrap(async (req, res) => {
  const scope = scopeFor(req);
  const today = todayStr();
  const uid = req.session.user.id;

  const tc = challengeTeamClause(scope, null);
  const featured = await queryAll(
    `SELECT * FROM challenges WHERE challenge_date = ?${tc.sql} ORDER BY created_at DESC`,
    [today, ...tc.params]
  );
  for (const ch of featured) {
    ch.userScore = await queryOne('SELECT * FROM scores WHERE user_id = ? AND challenge_id = ?', [uid, ch.id]);
    const p = await queryOne('SELECT COUNT(DISTINCT user_id) as count FROM scores WHERE challenge_id = ?', [ch.id]);
    ch.participants = p ? p.count : 0;
  }

  const rc = challengeTeamClause(scope, 'c');
  const upcoming = await queryAll(
    `SELECT c.* FROM challenges c WHERE c.challenge_date > ?${rc.sql} ORDER BY c.challenge_date ASC LIMIT 10`,
    [today, ...rc.params]
  );
  const recentChallenges = await queryAll(
    `SELECT c.*, COUNT(s.id) as score_count FROM challenges c LEFT JOIN scores s ON c.id = s.challenge_id
     WHERE c.challenge_date < ?${rc.sql} GROUP BY c.id ORDER BY c.challenge_date DESC LIMIT 5`,
    [today, ...rc.params]
  );

  res.render('dashboard', { featured, upcoming, recentChallenges, teamName: await scopeName(scope) });
}));

// Login/Register
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body;
  const user = await queryOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Invalid credentials' });
  }
  req.session.user = { id: user.id, username: user.username, is_admin: !!user.is_admin, team_id: user.team_id ?? null };
  res.redirect('/');
}));

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', wrap(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.render('register', { error: 'Username 3+ chars, password 4+ chars' });
  }
  if (await queryOne('SELECT id FROM users WHERE username = ?', [username])) {
    return res.render('register', { error: 'Username taken' });
  }
  // Player picks their own team at signup; only accept a real team id.
  let teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (teamId != null && !(await queryOne('SELECT id FROM teams WHERE id = ?', [teamId]))) teamId = null;
  const hash = bcrypt.hashSync(password, 10);
  const rs = await run('INSERT INTO users (username, password_hash, team_id) VALUES (?, ?, ?)', [username, hash, teamId]);
  const lastId = Number(rs.lastInsertRowid);
  req.session.user = { id: lastId, username, is_admin: false, team_id: teamId };
  res.redirect('/');
}));

app.post('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

// Admin team toggle
app.post('/set-team', requireAdmin, (req, res) => {
  const t = req.body.team;
  req.session.activeTeam = (!t || t === 'all') ? 'all' : t;
  res.redirect(req.get('referer') || '/');
});

// Challenge View & Submit
app.get('/challenge/:id', requireAuth, wrap(async (req, res) => {
  const scope = scopeFor(req);
  const challenge = await queryOne(
    'SELECT c.*, t.name AS team_name FROM challenges c LEFT JOIN teams t ON c.team_id = t.id WHERE c.id = ?',
    [req.params.id]
  );
  if (!challenge) return res.redirect('/');
  if (!scope.all && challenge.team_id != null && challenge.team_id !== scope.teamId) return res.redirect('/');

  const myScore = await queryOne('SELECT * FROM scores WHERE user_id = ? AND challenge_id = ?', [req.session.user.id, challenge.id]);

  const utc = userTeamClause(scope, 'u');
  const allScores = await queryAll(
    `SELECT s.*, u.username FROM scores s JOIN users u ON s.user_id = u.id
     WHERE s.challenge_id = ?${utc.sql} ORDER BY s.submitted_at ASC`,
    [challenge.id, ...utc.params]
  );

  res.render('challenge', {
    challenge,
    myScore,
    rankedScores: calculatePoints(allScores, challenge.scoring_type),
    isOpen: isChallengeOpen(challenge),
  });
}));

app.post('/challenge/:id/submit', requireAuth, wrap(async (req, res) => {
  const scope = scopeFor(req);
  const challenge = await queryOne('SELECT * FROM challenges WHERE id = ?', [req.params.id]);
  if (!challenge) return res.redirect('/');
  if (!scope.all && challenge.team_id != null && challenge.team_id !== scope.teamId) return res.redirect('/');
  if (!isChallengeOpen(challenge)) return res.redirect(`/challenge/${challenge.id}`);

  let scoreValue;
  if (challenge.scoring_type === 'min_time') {
    const minutes = parseInt(req.body.minutes, 10) || 0;
    const seconds = parseFloat(req.body.seconds) || 0;
    if (minutes < 0 || seconds < 0 || seconds >= 60) return res.status(400).send('Invalid time (seconds must be 0-59)');
    scoreValue = Math.round((minutes * 60 + seconds) * 100) / 100;
    if (scoreValue <= 0) return res.status(400).send('Enter a time greater than zero');
  } else {
    scoreValue = parseFloat(req.body.scoreValue);
    if (isNaN(scoreValue) || scoreValue < 0) return res.status(400).send('Invalid score');
  }

  await run(
    "INSERT OR REPLACE INTO scores (user_id, challenge_id, score_value, submitted_at) VALUES (?, ?, ?, datetime('now'))",
    [req.session.user.id, challenge.id, scoreValue]
  );
  res.redirect(`/challenge/${challenge.id}`);
}));

// Leaderboard
app.get('/leaderboard', requireAuth, wrap(async (req, res) => {
  const scope = scopeFor(req);
  const period = req.query.period || 'all';
  let dateFilter = '';
  if (period === 'week') dateFilter = "AND c.challenge_date >= date('now', '-7 days')";
  else if (period === 'month') dateFilter = "AND c.challenge_date >= date('now', '-30 days')";

  const ctc = challengeTeamClause(scope, 'c');
  const utc = userTeamClause(scope, 'u');
  const allScores = await queryAll(
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
  const challengesList = await queryAll(
    `SELECT c.id, c.title, c.category, c.scoring_type, c.challenge_date FROM challenges c
     WHERE 1=1 ${dateFilter}${clc.sql} ORDER BY c.challenge_date DESC`,
    clc.params
  );

  res.render('leaderboard', { leaderboard, period, challengesList, teamName: await scopeName(scope) });
}));

// ========== Admin Panel ==========
// Admin: Challenges page (create + existing)
app.get('/admin', requireAdmin, wrap(async (req, res) => {
  const challenges = await queryAll(
    `SELECT c.*, t.name AS team_name FROM challenges c LEFT JOIN teams t ON c.team_id = t.id
     ORDER BY c.challenge_date DESC, c.created_at DESC`
  );
  res.render('admin', { challenges });
}));

// Admin: People page (teams + users)
app.get('/admin/people', requireAdmin, wrap(async (req, res) => {
  const users = await queryAll(
    `SELECT u.id, u.username, u.is_admin, u.team_id, t.name AS team_name
     FROM users u LEFT JOIN teams t ON u.team_id = t.id ORDER BY u.username`
  );
  const teams = await queryAll(
    `SELECT tm.id, tm.name,
       (SELECT COUNT(*) FROM users u2 WHERE u2.team_id = tm.id) AS member_count,
       (SELECT COUNT(*) FROM challenges c2 WHERE c2.team_id = tm.id) AS challenge_count
     FROM teams tm ORDER BY tm.name`
  );
  res.render('admin-people', { users, teams, currentUserId: req.session.user.id });
}));

// --- Challenges ---
app.post('/admin/create-challenge', requireAdmin, wrap(async (req, res) => {
  const { title, description, category, scoringType, unit, challengeDate } = req.body;
  const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (!title || !category || !scoringType || !unit || !challengeDate) return res.status(400).send('Missing fields');
  await run(
    'INSERT INTO challenges (title, description, category, scoring_type, unit, challenge_date, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title, description || '', category, scoringType, unit, challengeDate, teamId]
  );
  res.redirect('/admin');
}));

app.post('/admin/edit-challenge/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (!(await queryOne('SELECT id FROM challenges WHERE id = ?', [id]))) return res.redirect('/admin');
  await run('UPDATE challenges SET team_id = ? WHERE id = ?', [teamId, id]);
  res.redirect('/admin');
}));

app.post('/admin/update-challenge/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(await queryOne('SELECT id FROM challenges WHERE id = ?', [id]))) return res.redirect('/admin');
  const { title, description, category, scoringType, unit, challengeDate } = req.body;
  const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (!title || !category || !scoringType || !unit || !challengeDate) return res.status(400).send('Missing fields');
  await run(
    'UPDATE challenges SET title = ?, description = ?, category = ?, scoring_type = ?, unit = ?, challenge_date = ?, team_id = ? WHERE id = ?',
    [title, description || '', category, scoringType, unit, challengeDate, teamId, id]
  );
  res.redirect('/admin');
}));

app.post('/admin/delete-challenge/:id', requireAdmin, wrap(async (req, res) => {
  await run('DELETE FROM scores WHERE challenge_id = ?', [req.params.id]);
  await run('DELETE FROM challenges WHERE id = ?', [req.params.id]);
  res.redirect('/admin');
}));

// --- Users --- (all redirect to the People page)
app.post('/admin/create-user', requireAdmin, wrap(async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const isAdmin = req.body.is_admin ? 1 : 0;
  const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (username.length < 3 || password.length < 4) return res.status(400).send('Username must be 3+ chars and password 4+ chars');
  if (await queryOne('SELECT id FROM users WHERE username = ?', [username])) return res.status(400).send('Username taken');
  const hash = bcrypt.hashSync(password, 10);
  await run('INSERT INTO users (username, password_hash, is_admin, team_id) VALUES (?, ?, ?, ?)', [username, hash, isAdmin, teamId]);
  res.redirect('/admin/people');
}));

app.post('/admin/edit-user/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const username = (req.body.username || '').trim();
  let isAdmin = req.body.is_admin ? 1 : 0;
  const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
  if (username.length < 3) return res.status(400).send('Username must be 3+ chars');
  if (await queryOne('SELECT id FROM users WHERE username = ? AND id != ?', [username, id])) return res.status(400).send('Username taken');
  if (id === req.session.user.id) isAdmin = 1; // don't let an admin lock themselves out
  await run('UPDATE users SET username = ?, is_admin = ?, team_id = ? WHERE id = ?', [username, isAdmin, teamId, id]);
  res.redirect('/admin/people');
}));

app.post('/admin/delete-user/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.user.id) return res.redirect('/admin/people');
  await run('DELETE FROM scores WHERE user_id = ?', [id]);
  await run('DELETE FROM users WHERE id = ?', [id]);
  res.redirect('/admin/people');
}));

app.post('/admin/reset-password/:id', requireAdmin, wrap(async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).send('Password must be at least 4 characters');
  if (!(await queryOne('SELECT id FROM users WHERE id = ?', [req.params.id]))) return res.redirect('/admin/people');
  const hash = bcrypt.hashSync(newPassword, 10);
  await run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
  res.redirect('/admin/people');
}));

// --- Teams --- (all redirect to the People page)
app.post('/admin/create-team', requireAdmin, wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/people');
  if (!(await queryOne('SELECT id FROM teams WHERE name = ?', [name]))) {
    await run('INSERT INTO teams (name) VALUES (?)', [name]);
  }
  res.redirect('/admin/people');
}));

app.post('/admin/rename-team/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/people');
  if (await queryOne('SELECT id FROM teams WHERE name = ? AND id != ?', [name, id])) return res.status(400).send('Team name taken');
  await run('UPDATE teams SET name = ? WHERE id = ?', [name, id]);
  res.redirect('/admin/people');
}));

app.post('/admin/delete-team/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await run('UPDATE users SET team_id = NULL WHERE team_id = ?', [id]);
  await run('UPDATE challenges SET team_id = NULL WHERE team_id = ?', [id]);
  await run('DELETE FROM teams WHERE id = ?', [id]);
  res.redirect('/admin/people');
}));

// Change Password (self-service)
app.get('/change-password', requireAuth, (req, res) => res.render('change-password', { error: null, success: null }));
app.post('/change-password', requireAuth, wrap(async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const userData = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
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
  await run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.session.user.id]);
  res.render('change-password', { error: null, success: 'Password updated!' });
}));

// ========== Error handling ==========
app.use((err, req, res, next) => {
  console.error('Route error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).send('Something went wrong. Please try again.');
});

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

// ========== Start ==========
const PORT = process.env.PORT || 3000;
ensureSchema().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Running on port ${PORT}`);
    console.log(`🗄️  DB: ${DB_URL.startsWith('file:') ? DB_URL + ' (local file)' : 'Turso (remote)'}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
