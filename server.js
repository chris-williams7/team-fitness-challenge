const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');

const app = express();
const DB_PATH = process.env.RENDER ? '/var/data/fitness.db' : './fitness.db';
const db = new Database(DB_PATH);

// ---------- Schema Setup ----------
db.exec(`
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
`);

// Create default admin
const adminExists = db.prepare("SELECT COUNT(*) as count FROM users WHERE username = 'admin'").get();
if (adminExists.count === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)").run('admin', hash);
  console.log('Default admin created — username: admin, password: admin123');
}

// ---------- Middleware ----------
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

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
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

// ---------- Points Calculation ----------
function calculatePoints(scores, scoringType) {
  const sorted = [...scores].sort((a, b) =>
    scoringType === 'min_time' ? a.score_value - b.score_value : b.score_value - a.score_value
  );
  const pointsMap = [10, 8, 6, 5, 4, 3, 2, 1];
  return sorted.map((entry, i) => ({ ...entry, rank: i + 1, points: i < pointsMap.length ? pointsMap[i] : 1 }));
}

// ========== ROUTES ==========

// Home
app.get('/', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const todayChallenge = db.prepare("SELECT * FROM challenges WHERE challenge_date = ? ORDER BY created_at DESC LIMIT 1").get(today);
  let userScore = null, participants = 0;
  if (todayChallenge) {
    userScore = db.prepare("SELECT * FROM scores WHERE user_id = ? AND challenge_id = ?").get(req.session.user.id, todayChallenge.id);
    participants = db.prepare("SELECT COUNT(DISTINCT user_id) as count FROM scores WHERE challenge_id = ?").get(todayChallenge.id).count;
  }
  const recentChallenges = db.prepare("SELECT c.*, COUNT(s.id) as score_count FROM challenges c LEFT JOIN scores s ON c.id = s.challenge_id GROUP BY c.id ORDER BY c.challenge_date DESC LIMIT 5").all();
  res.render('dashboard', { todayChallenge, userScore, participants, recentChallenges });
});

// Login/Register
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.render('login', { error: 'Invalid credentials' });
  req.session.user = { id: user.id, username: user.username, is_admin: !!user.is_admin };
  res.redirect('/');
});

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (username.length < 3 || password.length < 4) return res.render('register', { error: 'Username 3+ chars, password 4+ chars' });
  if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) return res.render('register', { error: 'Username taken' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(username, hash);
  req.session.user = { id: result.lastInsertRowid, username, is_admin: false };
  res.redirect('/');
});

app.post('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// Challenge View & Submit
app.get('/challenge/:id', requireAuth, (req, res) => {
  const challenge = db.prepare("SELECT * FROM challenges WHERE id = ?").get(req.params.id);
  if (!challenge) return res.redirect('/');
  const myScore = db.prepare("SELECT * FROM scores WHERE user_id = ? AND challenge_id = ?").get(req.session.user.id, challenge.id);
  const allScores = db.prepare("SELECT s.*, u.username FROM scores s JOIN users u ON s.user_id = u.id WHERE s.challenge_id = ? ORDER BY s.submitted_at ASC").all(challenge.id);
  const rankedScores = calculatePoints(allScores, challenge.scoring_type);
  res.render('challenge', { challenge, myScore, rankedScores });
});

app.post('/challenge/:id/submit', requireAuth, (req, res) => {
  const challenge = db.prepare("SELECT * FROM challenges WHERE id = ?").get(req.params.id);
  if (!challenge) return res.redirect('/');
  const scoreValue = parseFloat(req.body.scoreValue);
  if (isNaN(scoreValue) || scoreValue < 0) return res.status(400).send('Invalid score');
  db.prepare("INSERT INTO scores (user_id, challenge_id, score_value) VALUES (?, ?, ?) ON CONFLICT(user_id, challenge_id) DO UPDATE SET score_value = excluded.score_value").run(req.session.user.id, challenge.id, scoreValue);
  res.redirect(`/challenge/${challenge.id}`);
});

// Leaderboard
app.get('/leaderboard', requireAuth, async (req, res) => {
  const period = req.query.period || 'all';
  let dateFilter = '', params = [];
  if (period === 'week') { dateFilter = "AND c.challenge_date >= date('now', '-7 days')"; }
  else if (period === 'month') { dateFilter = "AND c.challenge_date >= date('now', '-30 days')"; }
  
  const allScores = db.prepare(`SELECT s.user_id, u.username, s.score_value, s.challenge_id, c.scoring_type, c.title, c.category FROM scores s JOIN users u ON s.user_id = u.id JOIN challenges c ON s.challenge_id = c.id WHERE 1=1 ${dateFilter}`).all(...params);
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
  const challengesList = db.prepare(`SELECT id, title, category, scoring_type, challenge_date FROM challenges WHERE 1=1 ${dateFilter} ORDER BY challenge_date DESC`).all(...params);
  res.render('leaderboard', { leaderboard, period, challengesList, categoryStats: {} });
});

// Admin Panel
app.get('/admin', requireAdmin, (req, res) => {
  const challenges = db.prepare("SELECT * FROM challenges ORDER BY challenge_date DESC, created_at DESC").all();
  const users = db.prepare("SELECT id, username, is_admin FROM users ORDER BY username").all();
  res.render('admin', { challenges, users, success: null, error: null });
});

app.post('/admin/create-challenge', requireAdmin, (req, res) => {
  const { title, description, category, scoringType, unit, challengeDate } = req.body;
  if (!title || !category || !scoringType || !unit || !challengeDate) return res.status(400).send('Missing fields');
  db.prepare("INSERT INTO challenges (title, description, category, scoring_type, unit, challenge_date) VALUES (?, ?, ?, ?, ?, ?)").run(title, description || '', category, scoringType, unit, challengeDate);
  res.redirect('/admin');
});

app.post('/admin/delete-challenge/:id', requireAdmin, (req, res) => {
  db.prepare("DELETE FROM scores WHERE challenge_id = ?").run(req.params.id);
  db.prepare("DELETE FROM challenges WHERE id = ?").run(req.params.id);
  res.redirect('/admin');
});

// Change Password
app.get('/change-password', requireAuth, (req, res) => res.render('change-password', { error: null, success: null }));
app.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.session.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) return res.render('change-password', { error: 'Current password incorrect' });
  if (!newPassword || newPassword.length < 4) return res.render('change-password', { error: 'Min 4 characters required' });
  if (newPassword !== confirmPassword) return res.render('change-password', { error: 'Passwords do not match' });
  if (newPassword === currentPassword) return res.render('change-password', { error: 'Must be different' });
  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, req.session.user.id);
  res.render('change-password', { error: null, success: 'Password updated!' });
});

// Start Server
const PORT = process.env.PORT || 3000;
console.log(`Starting server on port ${PORT}...`);
app.listen(PORT, () => console.log(`🚀 Running on port ${PORT}\n   Default admin: admin / admin123`));