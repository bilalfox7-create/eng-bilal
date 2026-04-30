const express = require('express');
const session = require('express-session');
const path    = require('path');
const fs      = require('fs');
const { initDb, getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'eng-ieshat-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use('/auth', require('./routes/auth'));
app.use('/api',  require('./routes/api'));

app.get('*', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb();

/* ── Auto backup every 24h ───────────────────────────── */
const apiRouter = require('./routes/api');
const BACKUP_DIR = apiRouter.BACKUP_DIR;

function runBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const db   = getDb();
    const rows = db.prepare('SELECT key, data, cfg, saved_at, expenses, attendance FROM months').all();
    const months = {};
    for (const row of rows) {
      months[row.key] = {
        data:       JSON.parse(row.data),
        cfg:        JSON.parse(row.cfg),
        savedAt:    row.saved_at || null,
        expenses:   row.expenses   ? JSON.parse(row.expenses)   : null,
        attendance: row.attendance ? JSON.parse(row.attendance) : null,
      };
    }
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(BACKUP_DIR, `backup-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify({ months }, null, 2));
    // Keep only last 7 backups
    const all = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
    while (all.length > 7) { fs.unlinkSync(path.join(BACKUP_DIR, all.shift())); }
    console.log(`✅ نسخة احتياطية: ${file}`);
  } catch (e) { console.error('❌ فشل النسخ الاحتياطي:', e.message); }
}

// Run once on startup then every 24h
setTimeout(() => { runBackup(); setInterval(runBackup, 24 * 60 * 60 * 1000); }, 5000);

app.listen(PORT, () => console.log(`🚀 Server ready → http://localhost:${PORT}`));
