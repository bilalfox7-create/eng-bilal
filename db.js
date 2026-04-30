const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');

// على Railway نستخدم /data (volume) وإلا المجلد الحالي
const DB_PATH = process.env.DB_PATH ||
  (process.env.RAILWAY_ENVIRONMENT ? '/data/data.db' : path.join(__dirname, 'data.db'));

let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
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
      saved_at TEXT,
      expenses TEXT
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

    CREATE TABLE IF NOT EXISTS org_chart (
      id   INTEGER PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);

  // أضف أعمدة للقواعد القديمة
  try { db.exec('ALTER TABLE months ADD COLUMN expenses TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE months ADD COLUMN attendance TEXT'); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'"); } catch(e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN province TEXT'); } catch(e) {}

  // تأكد أن جميع المستخدمين بدون role يحصلون على 'admin' (صفوف قديمة)
  db.exec("UPDATE users SET role = 'admin' WHERE role IS NULL AND province IS NULL");

  // إنشاء مستخدم الأدمن الافتراضي إذا لم يكن موجوداً
  const count = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get();
  if (Number(count.c) === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, 'admin')").run('admin', hash);
    console.log('✅ تم إنشاء المستخدم الافتراضي: admin / admin123');
    console.log('⚠️  غيّر كلمة المرور من صفحة الإعدادات بعد أول تسجيل دخول.');
  }

  // إنشاء مستخدمي المحافظات إذا لم يكونوا موجودين
  const provUsers = [
    { username: 'derna',    password: 'derna123',    province: 'محافظة درنة'    },
    { username: 'albaida',  password: 'albaida123',  province: 'محافظة البيضاء' },
    { username: 'benghazi', password: 'benghazi123', province: 'محافظة بنغازى'  },
    { username: 'tobruk',   password: 'tobruk123',   province: 'محافظة طبرق'   },
  ];
  for (const u of provUsers) {
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
    if (!exists) {
      const hash = bcrypt.hashSync(u.password, 10);
      db.prepare("INSERT INTO users (username, password, role, province) VALUES (?, ?, 'province', ?)").run(u.username, hash, u.province);
      console.log(`✅ مستخدم المحافظة: ${u.username} / ${u.password} (${u.province})`);
    }
  }
}

module.exports = { getDb, initDb };
