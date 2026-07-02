const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const app = express();
let db = null;

// Database file path
const DB_PATH = process.env.RENDER ? '/var/data/fitness.db' : './fitness.db';
const IS_RENDER = !!process.env.RENDER;

async function loadDatabase() {
  const SQL = await initSqlJs();
  
  try {
    // Try to load existing database from disk
    const fileBuffer = await fs.readFile(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log(`Loaded existing database from ${DB_PATH}`);
  } catch (err) {
    // Create fresh database if none exists
    db = new SQL.Database();
    
    // Run schema setup
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
    `);
    
    // Create default admin
    const stmt = db.prepare("SELECT COUNT(*) as count FROM users WHERE username = 'admin'");
    stmt.step();
    const result = stmt.getAsObject();
    stmt.free();
    
    if (result.count === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      db.run("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)", ['admin', hash]);
      console.log('Default admin created — username: admin, password: admin123');
    }
    
    console.log('Created new database');
  }
}

async function saveDatabase() {
  if (!db) return;
  
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    
    // Ensure directory exists
    const dirPath = path.dirname(DB_PATH);
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (e) {
      // Directory might exist, ignore error
    }
    
    await fs.writeFile(DB_PATH, buffer);
    console.log(`Database saved to ${DB_PATH}`);
  } catch (err) {
    console.error('Failed to save database:', err.message);
  }
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

// ========== Helper Functions ==========

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
  const today = new Date().toISOString().split('T')[0];
  
  const todayChallengeStmt = db.prepare("SELECT * FROM challenges WHERE challenge_date = ? ORDER BY created_at DESC LIMIT 1");
  todayChallengeStmt.bind([today]);
  const todayChallenge = todayChallengeStmt.step() ? todayChallengeStmt.getAsObject() : null;
  todayChallengeStmt.free();
  
  let userScore = null, participants = 0;
  if (todayChallenge) {
    const userStmt = db.prepare("SELECT * FROM scores WHERE user_id = ? AND challenge_id = ?");
    userStmt.bind([req.session.user.id, todayChallenge.id]);
    userScore = userStmt.step() ? userStmt.getAsObject() : null;
    userStmt.free();
    
    const participantStmt = db.prepare("SELECT COUNT(DISTINCT user_id) as count FROM scores WHERE challenge_id = ?");
    participantStmt.bind([todayChallenge.id]);
    participantStmt.step();
    participants = participantStmt.getAsObject().count;
    participantStmt.free();
  }
  
  const recentStmt = db.prepare("SELECT c.*, COUNT(s.id) as score_count FROM challenges c LEFT JOIN scores s ON c.id = s.challenge_id GROUP BY c.id ORDER BY c.challenge_date DESC LIMIT 5");
  const recentChallenges = [];
  while(recentStmt.step()) {
    recentChallenges.push(recentStmt.getAsObject());
  }
  recentStmt.free();
  
  res.render('dashboard', { todayChallenge, userScore, participants, recentChallenges });
});

// Login/Register
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  const stmt = db.prepare("SELECT * FROM users WHERE username = ?");
  stmt.bind([username]);
  const user = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Invalid credentials' });
  }
  
  req.session.user = { id: user.id, username: user.username, is_admin: !!user.is_admin };
  res.redirect('/');
});

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (username.length < 3 || password.length < 4) {
    return res.render('register', { error: 'Username 3+ chars, password 4+ chars' });
  }
  
  // Check if username exists
  const checkStmt = db.prepare("SELECT id FROM users WHERE username = ?");
  checkStmt.bind([username]);
  const exists = checkStmt.step();
  checkStmt.free();
  
  if (exists) {
    return res.render('register', { error: 'Username taken' });
  }
  
  const hash = bcrypt.hashSync(password, 10);
  const insertStmt = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)");
  insertStmt.run([username, hash]);
  insertStmt.free();
  
  // Get the inserted ID
  const lastId = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] || 0;
  
  req.session.user = { id: lastId, username, is_admin: false };
  res.redirect('/');
});

app.post('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// Challenge View & Submit
app.get('/challenge/:id', requireAuth, (req, res) => {
  const challStmt = db.prepare("SELECT * FROM challenges WHERE id = ?");
  challStmt.bind([req.params.id]);
  const challenge = challStmt.step() ? challStmt.getAsObject() : null;
  challStmt.free();
  
  if (!challenge) return res.redirect('/');
  
  // Get my score
  const myStmt = db.prepare("SELECT * FROM scores WHERE user_id = ? AND challenge_id = ?");
  myStmt.bind([req.session.user.id, challenge.id]);
  const myScore = myStmt.step() ? myStmt.getAsObject() : null;
  myStmt.free();
  
  // Get all scores with usernames
  const allStmt = db.prepare("SELECT s.*, u.username FROM scores s JOIN users u ON s.user_id = u.id WHERE s.challenge_id = ? ORDER BY s.submitted_at ASC");
  allStmt.bind([challenge.id]);
  const allScores = [];
  while(allStmt.step()) {
    allScores.push(allStmt.getAsObject());
  }
  allStmt.free();
  
  const rankedScores = calculatePoints(allScores, challenge.scoring_type);
  res.render('challenge', { challenge, myScore, rankedScores });
});

app.post('/challenge/:id/submit', requireAuth, (req, res) => {
  const challStmt = db.prepare("SELECT * FROM challenges WHERE id = ?");
  challStmt.bind([req.params.id]);
  const challenge = challStmt.step() ? challStmt.getAsObject() : null;
  challStmt.free();
  
  if (!challenge) return res.redirect('/');
  
  const scoreValue = parseFloat(req.body.scoreValue);
  if (isNaN(scoreValue) || scoreValue < 0) return res.status(400).send('Invalid score');
  
  // UPSERT score using REPLACE
  db.run("INSERT OR REPLACE INTO scores (user_id, challenge_id, score_value, submitted_at) VALUES (?, ?, ?, datetime('now'))", 
         [req.session.user.id, challenge.id, scoreValue]);
  
  res.redirect(`/challenge/${challenge.id}`);
});

// Leaderboard
app.get('/leaderboard', requireAuth, async (req, res) => {
  const period = req.query.period || 'all';
  let dateFilter = '';
  
  if (period === 'week') { dateFilter = "AND c.challenge_date >= date('now', '-7 days')"; }
  else if (period === 'month') { dateFilter = "AND c.challenge_date >= date('now', '-30 days')"; }
  
  // Get all scores
  const stmt = db.prepare(`SELECT s.user_id, u.username, s.score_value, s.challenge_id, c.scoring_type, c.title, c.category FROM scores s JOIN users u ON s.user_id = u.id JOIN challenges c ON s.challenge_id = c.id WHERE 1=1 ${dateFilter}`);
  stmt.bind([]);
  const allScores = [];
  while(stmt.step()) {
    allScores.push(stmt.getAsObject());
  }
  stmt.free();
  
  // Group by challenge
  const challengesMap = {};
  for (const row of allScores) {
    if (!challengesMap[row.challenge_id]) challengesMap[row.challenge_id] = [];
    challengesMap[row.challenge_id].push(row);
  }
  
  // Calculate leaderboards
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
  
  // Get completed challenges list
  const listStmt = db.prepare(`SELECT id, title, category, scoring_type, challenge_date FROM challenges WHERE 1=1 ${dateFilter} ORDER BY challenge_date DESC`);
  const challengesList = [];
  while(listStmt.step()) {
    challengesList.push(listStmt.getAsObject());
  }
  listStmt.free();
  
  res.render('leaderboard', { leaderboard, period, challengesList, categoryStats: {} });
});

// Admin Panel
app.get('/admin', requireAdmin, (req, res) => {
  const chStmt = db.prepare("SELECT * FROM challenges ORDER BY challenge_date DESC, created_at DESC");
  const challenges = [];
  while(chStmt.step()) {
    challenges.push(chStmt.getAsObject());
  }
  chStmt.free();
  
  const usStmt = db.prepare("SELECT id, username, is_admin FROM users ORDER BY username");
  const users = [];
  while(usStmt.step()) {
    users.push(usStmt.getAsObject());
  }
  usStmt.free();
  
  res.render('admin', { challenges, users, success: null, error: null });
});

app.post('/admin/create-challenge', requireAdmin, (req, res) => {
  const { title, description, category, scoringType, unit, challengeDate } = req.body;
  if (!title || !category || !scoringType || !unit || !challengeDate) return res.status(400).send('Missing fields');
  
  db.run("INSERT INTO challenges (title, description, category, scoring_type, unit, challenge_date) VALUES (?, ?, ?, ?, ?, ?)", 
         [title, description || '', category, scoringType, unit, challengeDate]);
  res.redirect('/admin');
});

app.post('/admin/delete-challenge/:id', requireAdmin, (req, res) => {
  db.run("DELETE FROM scores WHERE challenge_id = ?", [req.params.id]);
  db.run("DELETE FROM challenges WHERE id = ?", [req.params.id]);
  res.redirect('/admin');
});

// Change Password
app.get('/change-password', requireAuth, (req, res) => res.render('change-password', { error: null, success: null }));
app.post('/change-password', async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  
  const stmt = db.prepare("SELECT password_hash FROM users WHERE id = ?");
  stmt.bind([req.session.user.id]);
  const userData = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  
  if (!userData || !bcrypt.compareSync(currentPassword, userData.password_hash)) {
    return res.render('change-password', { error: 'Current password incorrect' });
  }
  
  if (!newPassword || newPassword.length < 4) {
    return res.render('change-password', { error: 'Min 4 characters required' });
  }
  
  if (newPassword !== confirmPassword) {
    return res.render('change-password', { error: 'Passwords do not match' });
  }
  
  if (newPassword === currentPassword) {
    return res.render('change-password', { error: 'Must be different' });
  }
  
  const newHash = bcrypt.hashSync(newPassword, 10);
  db.run("UPDATE users SET password_hash = ? WHERE id = ?", [newHash, req.session.user.id]);
  res.render('change-password', { error: null, success: 'Password updated!' });
});

// ========== Graceful Shutdown ==========

async function shutdown() {
  console.log('\nShutting down... Saving database.');
  await saveDatabase();
  console.log('Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ========== Start Server ==========

const PORT = process.env.PORT || 3000;

loadDatabase().then(() => {
  console.log(`Starting server on port ${PORT}...`);
  const server = app.listen(PORT, () => {
    console.log(`🚀 Running on port ${PORT}\n   Default admin: admin / admin123`);
    console.log(`${IS_RENDER ? '⚠️ RENDER MODE: Data persists to /var/data/fitness.db' : '💾 LOCAL MODE: Data saves to ./fitness.db'}`);
  });
  
  // Save periodically on render (every 5 minutes)
  if (IS_RENDER) {
    setInterval(saveDatabase, 5 * 60 * 1000);
  }
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
