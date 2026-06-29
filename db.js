const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const path = require('path');

/* ──────────────────────────────────────────────────────────────
   Database connection (libSQL / Turso)

   Production (Render + Turso): set these env vars
     TURSO_DATABASE_URL = libsql://<your-db>.turso.io
     TURSO_AUTH_TOKEN   = <token>
   Local dev / fallback: an embedded SQLite file (no network needed).
   The data lives in Turso's cloud — separate from the web host — so
   if the host ever goes offline the data stays safe.
   ────────────────────────────────────────────────────────────── */
const url =
  process.env.TURSO_DATABASE_URL ||
  ('file:' + path.join(__dirname, 'data-local.db'));
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

let client;
function getClient() {
  if (!client) {
    client = createClient({ url, authToken });
  }
  return client;
}

/* ── Async helpers mirroring the old sync prepare().get/run/all API ──
   Call sites do:  await get(sql, [args])  /  await run(...)  /  await all(...)
*/
async function get(sql, args = []) {
  const r = await getClient().execute({ sql, args });
  return r.rows[0]; // undefined if none
}
async function all(sql, args = []) {
  const r = await getClient().execute({ sql, args });
  return r.rows;
}
async function run(sql, args = []) {
  const r = await getClient().execute({ sql, args });
  return {
    changes: Number(r.rowsAffected || 0),
    lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : undefined,
  };
}
/* multiple semicolon-separated statements, no params (DDL scripts) */
async function exec(sqlScript) {
  await getClient().executeMultiple(sqlScript);
}
/* transactional batch of write statements: [{ sql, args }, ...] */
async function batchWrite(statements) {
  await getClient().batch(statements, 'write');
}

async function initDb() {
  // Full final schema (all columns inlined — fresh Turso DB starts clean).
  await exec(`
    CREATE TABLE IF NOT EXISTS months (
      key        TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      cfg        TEXT NOT NULL,
      saved_at   TEXT,
      expenses   TEXT,
      attendance TEXT
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id                   INTEGER PRIMARY KEY,
      username             TEXT UNIQUE NOT NULL,
      password             TEXT NOT NULL,
      role                 TEXT DEFAULT 'admin',
      province             TEXT,
      must_change_password INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS org_chart (
      id   INTEGER PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id       INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      action   TEXT NOT NULL,
      detail   TEXT DEFAULT '',
      ts       INTEGER NOT NULL
    );
  `);

  // Backward-compat: if connecting to an older DB missing newer columns,
  // add them. On a fresh DB these throw "duplicate column" → ignored.
  const addCol = async (sql) => { try { await getClient().execute(sql); } catch (e) {} };
  await addCol("ALTER TABLE months ADD COLUMN expenses TEXT");
  await addCol("ALTER TABLE months ADD COLUMN attendance TEXT");
  await addCol("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'");
  await addCol("ALTER TABLE users ADD COLUMN province TEXT");
  await addCol("ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0");
  await addCol("ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1");

  // Old rows without a role → treat as admin.
  await run("UPDATE users SET role = 'admin' WHERE role IS NULL AND province IS NULL");

  // Default admin
  const count = await get("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
  if (Number(count.c) === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await run("INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'admin', 1)", ['admin', hash]);
    console.log('✅ تم إنشاء المستخدم الافتراضي: admin / admin123');
    console.log('⚠️  غيّر كلمة المرور من صفحة الإعدادات بعد أول تسجيل دخول.');
  }

  // Province users
  const provUsers = [
    { username: 'derna',    password: 'derna123',    province: 'محافظة درنة'    },
    { username: 'albaida',  password: 'albaida123',  province: 'محافظة البيضاء' },
    { username: 'benghazi', password: 'benghazi123', province: 'محافظة بنغازى'  },
    { username: 'tobruk',   password: 'tobruk123',   province: 'محافظة طبرق'   },
  ];
  for (const u of provUsers) {
    const exists = await get('SELECT id FROM users WHERE username = ?', [u.username]);
    if (!exists) {
      const hash = bcrypt.hashSync(u.password, 10);
      await run("INSERT INTO users (username, password, role, province, must_change_password) VALUES (?, ?, 'province', ?, 1)", [u.username, hash, u.province]);
      console.log(`✅ مستخدم المحافظة: ${u.username} / ${u.password} (${u.province})`);
    }
  }

  // Viewer users
  const viewerUsers = [
    { username: 'mohamed_basyouni', password: '123456' },
    { username: 'diaa_eldin',       password: '123456' },
  ];
  for (const u of viewerUsers) {
    const exists = await get('SELECT id FROM users WHERE username = ?', [u.username]);
    if (!exists) {
      const hash = bcrypt.hashSync(u.password, 10);
      await run("INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'viewer', 1)", [u.username, hash]);
      console.log(`✅ مستخدم مشاهد: ${u.username} / ${u.password}`);
    }
  }

  // HR user
  const hrUsers = [
    { username: 'mokhtar', password: '123456', display: 'مختار حسن' },
  ];
  for (const u of hrUsers) {
    const exists = await get('SELECT id FROM users WHERE username = ?', [u.username]);
    if (!exists) {
      const hash = bcrypt.hashSync(u.password, 10);
      await run("INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'hr', 1)", [u.username, hash]);
      console.log(`✅ مستخدم HR: ${u.username} / ${u.password} (${u.display})`);
    }
  }
}

module.exports = { getClient, initDb, get, all, run, exec, batchWrite };
