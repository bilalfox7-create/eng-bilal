const express    = require('express');
const compression= require('compression');
const session    = require('express-session');
const path       = require('path');
const fs         = require('fs');
const { initDb, all } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

/* ── gzip all responses ──────────────────────────────── */
app.use(compression());

/* ── Static files: cache assets 7 days, HTML via ETag ── */
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge:  '7d',
  etag:    true,
  lastModified: true,
  setHeaders(res, filePath) {
    // index.html: always revalidate (ETag check) but allow cache
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.use(express.json({ limit: '5mb' }));

const SESSION_SECRET = process.env.SESSION_SECRET || 'eng-ieshat-secret-key-2025';
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET غير مضبوط — استخدم متغير بيئة SESSION_SECRET في الإنتاج');
}

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

/* ── Health check for uptime monitoring ─────────────── */
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', require('./routes/auth'));
app.use('/api',  require('./routes/api'));

app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ── Auto backup every 24h ───────────────────────────── */
const apiRouter  = require('./routes/api');
const BACKUP_DIR = apiRouter.BACKUP_DIR;

async function runBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const rows = await all('SELECT key, data, cfg, saved_at, expenses, attendance FROM months');
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
    const allFiles = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
    while (allFiles.length > 100) fs.unlinkSync(path.join(BACKUP_DIR, allFiles.shift()));
    console.log(`✅ نسخة احتياطية: ${file}`);
  } catch (e) { console.error('❌ فشل النسخ الاحتياطي:', e.message); }
}

function scheduleNextBackup() {
  const t = new Date(); t.setHours(2, 0, 0, 0);
  if (t <= new Date()) t.setDate(t.getDate() + 1);
  setTimeout(() => { runBackup(); scheduleNextBackup(); }, t - new Date());
}

/* ── Start: connect + seed DB, then listen ───────────── */
(async () => {
  try {
    await initDb();
  } catch (e) {
    console.error('❌ فشل الاتصال بقاعدة البيانات:', e.message);
    process.exit(1);
  }
  setTimeout(() => { runBackup(); scheduleNextBackup(); }, 5000);
  app.listen(PORT, () => console.log(`🚀 Server ready → http://localhost:${PORT}`));
})();
