const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

// على Railway نستخدم /data (volume) وإلا المجلد الحالي
const DB_PATH = process.env.DB_PATH ||
  (process.env.RAILWAY_ENVIRONMENT ? '/data/data.db' : path.join(__dirname, 'data.db'));

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS months (
      key      TEXT PRIMARY KEY,
      data     TEXT NOT NULL,
      cfg      TEXT NOT NULL,
      saved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id       INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `);

  const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (count.c === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('admin', hash);
    console.log('✅ تم إنشاء المستخدم الافتراضي: admin / admin123');
    console.log('⚠️  غيّر كلمة المرور من صفحة الإعدادات بعد أول تسجيل دخول.');
  }
}

module.exports = { getDb, initDb };
