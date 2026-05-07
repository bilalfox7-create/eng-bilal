const express = require('express');
const bcrypt  = require('bcryptjs');
const fs      = require('fs');
const path    = require('path');
const { getDb } = require('../db');

const router = express.Router();

/* ── Active session tracker ─────────────────────────── */
const activeMap = new Map(); // userId -> { username, role, province, lastSeen }

/* ── Province save log ──────────────────────────────── */
const saveLogs = []; // { id, province, username, key, time }
let   saveLogId = 0;

/* ── Auth guard ──────────────────────────────────────── */
router.use((req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'غير مصرح' });
  const u = req.session.user;
  activeMap.set(u.id, {
    username: u.username,
    role:     u.role     || 'admin',
    province: u.province || null,
    lastSeen: Date.now(),
  });
  next();
});

const adminOnly = (req, res, next) => {
  const role = req.session.user.role || 'admin'; // NULL/undefined = old session = admin
  if (role !== 'admin') return res.status(403).json({ error: 'للأدمن فقط' });
  next();
};

/* ── Months ─────────────────────────────────────────── */

router.get('/months', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, data, cfg, saved_at, expenses, attendance FROM months').all();
  const months = {};
  for (const row of rows) {
    if (row.key === 'leaves') {
      // leaves stored as {requests:[...]} directly in data column
      months['leaves'] = JSON.parse(row.data);
    } else {
      months[row.key] = {
        data:       JSON.parse(row.data),
        cfg:        JSON.parse(row.cfg),
        savedAt:    row.saved_at || null,
        expenses:   row.expenses   ? JSON.parse(row.expenses)   : null,
        attendance: row.attendance ? JSON.parse(row.attendance) : null,
      };
    }
  }
  res.json({ months });
});

router.put('/months/:key', (req, res) => {
  const { key } = req.params;
  const user = req.session.user;
  const db   = getDb();

  /* ── Viewer + HR: read-only ── */
  if (user.role === 'viewer' || user.role === 'hr') return res.status(403).json({ error: 'للقراءة فقط' });

  /* ── Province user: merge-only update ── */
  if (user.role === 'province') {
    /* ── leaves: province can add/update their own province's requests ── */
    if (key === 'leaves') {
      const prov = user.province;
      const existing = db.prepare("SELECT data FROM months WHERE key = 'leaves'").get();
      const existingData = existing ? JSON.parse(existing.data) : {};
      const existingReqs = existingData.requests || [];
      const existingStatuses = existingData.engineerStatuses || {};
      const inReqs = req.body.requests || [];
      const otherReqs = existingReqs.filter(r => r.prov !== prov);
      const myReqs    = inReqs.filter(r => r.prov === prov);
      const merged = [...otherReqs, ...myReqs];
      db.prepare(`INSERT INTO months (key, data, cfg) VALUES ('leaves', ?, '{}')
        ON CONFLICT(key) DO UPDATE SET data = excluded.data`)
        .run(JSON.stringify({ requests: merged, engineerStatuses: existingStatuses }));
      return res.json({ ok: true });
    }

    const existing = db.prepare('SELECT * FROM months WHERE key = ?').get(key);
    if (!existing) return res.status(403).json({ error: 'الشهر غير موجود، تواصل مع الأدمن لإنشائه أولاً' });

    const existingData = JSON.parse(existing.data);
    const existingAtt  = existing.attendance ? JSON.parse(existing.attendance) : {};
    const prov         = user.province;
    const inData       = req.body.data       || {};
    const inAtt        = req.body.attendance || {};

    // Only update d1 / d2 / paid for engineers in their province
    const provEngIds = new Set((existingData[prov] || []).map(e => e.id));
    if (existingData[prov]) {
      existingData[prov] = existingData[prov].map(e => {
        const newE = (inData[prov] || []).find(ne => ne.id === e.id);
        if (!newE) return e;
        return { ...e, d1: newE.d1 ?? e.d1, d2: newE.d2 ?? e.d2, paid: newE.paid ?? e.paid };
      });
    }

    // Replace (not merge) attendance for engineers in their province
    // so deletions/clears propagate to DB
    provEngIds.forEach(engId => {
      if (inAtt[engId] !== undefined) {
        existingAtt[engId] = inAtt[engId];
      } else {
        delete existingAtt[engId];
      }
    });

    db.prepare('UPDATE months SET data = ?, attendance = ? WHERE key = ?')
      .run(JSON.stringify(existingData), JSON.stringify(existingAtt), key);

    // Log province save for admin notification
    saveLogs.push({ id: ++saveLogId, province: prov, username: user.username, key, time: Date.now() });
    if (saveLogs.length > 100) saveLogs.shift();

    return res.json({ ok: true });
  }

  /* ── Admin: full update ── */
  /* leaves special format: {requests:[...], engineerStatuses:{}} */
  if (key === 'leaves') {
    const requests = req.body.requests || [];
    const engineerStatuses = req.body.engineerStatuses || {};
    db.prepare(`INSERT INTO months (key, data, cfg) VALUES ('leaves', ?, '{}')
      ON CONFLICT(key) DO UPDATE SET data = excluded.data`)
      .run(JSON.stringify({ requests, engineerStatuses }));
    return res.json({ ok: true });
  }

  const { data, cfg, savedAt, expenses, attendance, force } = req.body;
  if (!data || !cfg) return res.status(400).json({ error: 'بيانات ناقصة' });

  /* ── DESTRUCTIVE WRITE GUARD ──
     Reject PUTs that would silently wipe non-trivial existing data.
     Client must explicitly pass { force: true } to bypass.
     Protects against stale-state autosaves (e.g. tab loaded before
     newer data was added in another tab/session).
  */
  if (!force) {
    const existing = db.prepare('SELECT data, expenses, attendance FROM months WHERE key = ?').get(key);
    if (existing) {
      const existingData = JSON.parse(existing.data || '{}');
      const existingExp  = existing.expenses ? JSON.parse(existing.expenses) : null;
      const existingAtt  = existing.attendance ? JSON.parse(existing.attendance) : null;
      const conflicts = [];
      /* Total engineer count across all provs (transfers move; not delete) */
      const totalBefore = Object.keys(existingData).reduce((a, p) => a + (existingData[p] || []).length, 0);
      const totalAfter  = Object.keys(data         ).reduce((a, p) => a + (data         [p] || []).length, 0);
      const isTransferLikeChange = totalBefore === totalAfter; // count preserved → likely transfer
      // Compare engineer counts per province (no province should silently lose engineers)
      // — but skip per-prov check when total count is preserved (transfer scenario)
      if (!isTransferLikeChange) {
        for (const prov of Object.keys(existingData)) {
          const before = (existingData[prov] || []).length;
          const after  = (data[prov]         || []).length;
          if (before > 0 && after < before) {
            conflicts.push(`المهندسين فى ${prov}: ${before} → ${after}`);
          }
        }
      }
      // Expenses: never silently null out non-empty data
      const expHadData = existingExp && (
        (existingExp.custody   || []).length +
        (existingExp.items     || []).length +
        (existingExp.transfers || []).length
      ) > 0;
      const expGoneNow = !expenses || (
        (expenses.custody   || []).length +
        (expenses.items     || []).length +
        (expenses.transfers || []).length
      ) === 0;
      if (expHadData && expGoneNow) conflicts.push('المصروفات والعهد ستُمسح');
      // Attendance: same check
      const attHadKeys = existingAtt ? Object.keys(existingAtt).length : 0;
      const attHasKeys = attendance  ? Object.keys(attendance).length  : 0;
      if (attHadKeys > 5 && attHasKeys < attHadKeys / 2) {
        conflicts.push(`الحضور: ${attHadKeys} → ${attHasKeys} سجلات`);
      }
      if (conflicts.length > 0) {
        return res.status(409).json({
          error: 'تعارض في الحفظ — البيانات الواردة ستمسح بيانات موجودة. أعد تحميل الصفحة وحاول مرة أخرى.',
          conflicts,
          needsForce: true,
        });
      }
    }

    /* ── Pre-save backup ──
       Snapshot the entire DB before this write. Cheap insurance —
       SQLite copy is ~kB. Keeps last 100 snapshots.
    */
    try {
      const BACKUP_DIR = process.env.DB_PATH
        ? path.join(path.dirname(process.env.DB_PATH), 'backups')
        : path.join(__dirname, '..', 'backups');
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const allRows = db.prepare('SELECT key, data, cfg, saved_at, expenses, attendance FROM months').all();
      const months = {};
      for (const row of allRows) {
        months[row.key] = {
          data:       JSON.parse(row.data),
          cfg:        JSON.parse(row.cfg),
          savedAt:    row.saved_at || null,
          expenses:   row.expenses   ? JSON.parse(row.expenses)   : null,
          attendance: row.attendance ? JSON.parse(row.attendance) : null,
        };
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.writeFileSync(path.join(BACKUP_DIR, `pre-save-${ts}-${key}.json`),
                       JSON.stringify({ months }, null, 0));
      const all = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
      while (all.length > 100) fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
    } catch (e) { console.error('pre-save backup failed:', e.message); }
  }

  db.prepare(`
    INSERT INTO months (key, data, cfg, saved_at, expenses, attendance) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      data       = excluded.data,
      cfg        = excluded.cfg,
      saved_at   = excluded.saved_at,
      expenses   = excluded.expenses,
      attendance = excluded.attendance
  `).run(key, JSON.stringify(data), JSON.stringify(cfg), savedAt || null,
         expenses   ? JSON.stringify(expenses)   : null,
         attendance ? JSON.stringify(attendance) : null);

  res.json({ ok: true });
});

router.delete('/months/:key', adminOnly, (req, res) => {
  getDb().prepare('DELETE FROM months WHERE key = ?').run(req.params.key);
  res.json({ ok: true });
});

/* ── Leave request management — admin + viewer + HR ─────── */
router.patch('/leaves/:id', (req, res) => {
  const user = req.session.user;
  if (user.role !== 'admin' && user.role !== 'viewer' && user.role !== 'hr') {
    return res.status(403).json({ error: 'للأدمن والمشرفين فقط' });
  }
  const { status, travelDate, returnDate } = req.body;
  const { id } = req.params;
  const db = getDb();

  const row = db.prepare("SELECT data FROM months WHERE key = 'leaves'").get();
  if (!row) return res.status(404).json({ error: 'لا توجد بيانات' });

  const requests = JSON.parse(row.data).requests || [];
  const idx = requests.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'الطلب غير موجود' });

  const item = { ...requests[idx] };

  if (status && ['approved', 'rejected'].includes(status) && item.status === 'pending') {
    item.status    = status;
    item.decidedBy = user.username;
    item.decidedAt = new Date().toISOString();
    if (!item.ticketStatus) item.ticketStatus = item.ticketBooked ? 'booked' : 'notBooked';

    if (status === 'approved' && item.leaveStartDate && item.leaveEndDate && item.engineerId) {
      const start = new Date(item.leaveStartDate + 'T12:00');
      const end   = new Date(item.leaveEndDate   + 'T12:00');
      let cur = new Date(start);
      const attMap = {};

      while (cur <= end) {
        if (cur.getDay() !== 5) {
          const mKey = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}`;
          if (!(mKey in attMap)) {
            const mRow = db.prepare('SELECT attendance FROM months WHERE key = ?').get(mKey);
            attMap[mKey] = mRow ? (mRow.attendance ? JSON.parse(mRow.attendance) : {}) : null;
          }
          if (attMap[mKey] !== null) {
            if (!attMap[mKey][item.engineerId]) attMap[mKey][item.engineerId] = {};
            attMap[mKey][item.engineerId][cur.getDate()] = { s: 'AL' };
          }
        }
        cur.setDate(cur.getDate() + 1);
      }

      for (const [mKey, att] of Object.entries(attMap)) {
        if (att !== null)
          db.prepare('UPDATE months SET attendance = ? WHERE key = ?').run(JSON.stringify(att), mKey);
      }
    }
  }

  if (travelDate  !== undefined) item.travelDate  = travelDate  || null;
  if (returnDate  !== undefined) item.returnDate  = returnDate  || null;

  /* ── Postpone ticket ── */
  const { postpone, cancelTicket: cancelTkt } = req.body;
  if (postpone && item.status === 'approved') {
    const hist = item.postponeHistory || [];
    hist.push({ date: new Date().toISOString(), reason: postpone.reason || '', oldDate: item.travelDate || '', newDate: postpone.newDate || '' });
    item.travelDate      = postpone.newDate || item.travelDate;
    item.ticketStatus    = 'postponed';
    item.postponeHistory = hist;
  }

  /* ── Cancel ticket ── */
  if (cancelTkt !== undefined) {
    item.ticketStatus  = 'cancelled';
    item.cancelReason  = cancelTkt.reason || '';
    item.cancelledAt   = new Date().toISOString();
  }

  requests[idx] = item;
  db.prepare("UPDATE months SET data = ? WHERE key = 'leaves'")
    .run(JSON.stringify({ requests }));

  res.json({ ok: true, request: item });
});

/* Replace ALL months (import → replace mode) — admin only */
router.put('/data', adminOnly, (req, res) => {
  const { months } = req.body;
  if (!months) return res.status(400).json({ error: 'بيانات ناقصة' });

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO months (key, data, cfg, saved_at, expenses, attendance) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      data       = excluded.data,
      cfg        = excluded.cfg,
      saved_at   = excluded.saved_at,
      expenses   = excluded.expenses,
      attendance = excluded.attendance
  `);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM months').run();
    for (const [key, m] of Object.entries(months)) {
      insert.run(key, JSON.stringify(m.data), JSON.stringify(m.cfg), m.savedAt || null,
                 m.expenses   ? JSON.stringify(m.expenses)   : null,
                 m.attendance ? JSON.stringify(m.attendance) : null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.json({ ok: true });
});

/* ── Org Chart — admin write ─────────────────────────── */

router.get('/org-chart', (_req, res) => {
  const row = getDb().prepare('SELECT data FROM org_chart WHERE id = 1').get();
  res.json({ data: row ? JSON.parse(row.data) : null });
});

router.put('/org-chart', adminOnly, (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'بيانات ناقصة' });
  getDb().prepare(`
    INSERT INTO org_chart (id, data) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data
  `).run(JSON.stringify(data));
  res.json({ ok: true });
});

/* ── Logo — admin write ──────────────────────────────── */

router.get('/logo', (_req, res) => {
  const row = getDb().prepare("SELECT value FROM app_config WHERE key = 'logo'").get();
  res.json({ logo: row ? row.value : null });
});

router.put('/logo', adminOnly, (req, res) => {
  const { logo } = req.body;
  getDb().prepare(`
    INSERT INTO app_config (key, value) VALUES ('logo', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(logo || null);
  res.json({ ok: true });
});

router.delete('/logo', adminOnly, (_req, res) => {
  getDb().prepare("DELETE FROM app_config WHERE key = 'logo'").run();
  res.json({ ok: true });
});

/* ── Fixed rents config ──────────────────────────────── */

const DEFAULT_FIXED_RENTS = [
  { id: 'r1', desc: 'سكن رقم 1', day: 1,  lyd: 5000, usd: 0, prov: '' },
  { id: 'r2', desc: 'سكن رقم 2', day: 7,  lyd: 3500, usd: 0, prov: '' },
  { id: 'r3', desc: 'سكن رقم 3', day: 22, lyd: 5000, usd: 0, prov: '' }
];

router.get('/fixed-rents', (_req, res) => {
  const row = getDb().prepare("SELECT value FROM app_config WHERE key = 'fixed_rents'").get();
  let rents;
  try { rents = row ? JSON.parse(row.value) : DEFAULT_FIXED_RENTS; }
  catch { rents = DEFAULT_FIXED_RENTS; }
  if (!Array.isArray(rents) || rents.length === 0) rents = DEFAULT_FIXED_RENTS;
  res.json({ rents });
});

router.put('/fixed-rents', adminOnly, (req, res) => {
  const { rents } = req.body;
  if (!Array.isArray(rents)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  getDb().prepare(`
    INSERT INTO app_config (key, value) VALUES ('fixed_rents', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(rents));
  res.json({ ok: true });
});

/* ── User management — admin only ───────────────────── */

router.get('/users', adminOnly, (_req, res) => {
  const users = getDb()
    .prepare("SELECT id, username, role, province FROM users WHERE role IN ('province','viewer','hr') ORDER BY role, username")
    .all();
  res.json({ users });
});

router.put('/users/:id/password', adminOnly, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  const hash = bcrypt.hashSync(password, 10);
  const result = getDb()
    .prepare("UPDATE users SET password = ?, must_change_password = 0 WHERE id = ? AND role IN ('province','viewer','hr')")
    .run(hash, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ ok: true });
});

router.post('/users', adminOnly, (req, res) => {
  const { username, password, province, role } = req.body;
  const userRole = role === 'viewer' ? 'viewer' : 'province';
  if (!username || !username.trim()) return res.status(400).json({ error: 'أدخل اسم المستخدم' });
  if (!password || password.length < 6)  return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
  if (userRole === 'province' && (!province || !province.trim())) return res.status(400).json({ error: 'اختر المحافظة' });
  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (exists) return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });
  const hash = bcrypt.hashSync(password, 10);
  const provVal = userRole === 'province' ? province.trim() : null;
  const result = db.prepare(
    'INSERT INTO users (username, password, role, province, must_change_password) VALUES (?, ?, ?, ?, 1)'
  ).run(username.trim(), hash, userRole, provVal);
  res.json({ ok: true, id: result.lastInsertRowid, username: username.trim(), role: userRole, province: provVal });
});

router.delete('/users/:id', adminOnly, (req, res) => {
  const result = getDb()
    .prepare("DELETE FROM users WHERE id = ? AND role IN ('province','viewer','hr')")
    .run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ ok: true });
});

/* ── Active users ────────────────────────────────────── */

router.get('/active-users', adminOnly, (_req, res) => {
  const THRESHOLD = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();
  const active = [];
  for (const [id, s] of activeMap.entries()) {
    if (now - s.lastSeen < THRESHOLD) {
      active.push({ id, username: s.username, role: s.role, province: s.province, lastSeen: s.lastSeen });
    }
  }
  res.json({ users: active });
});

/* ── Province save logs ──────────────────────────────── */

router.get('/save-logs', adminOnly, (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const recent = saveLogs.filter(l => l.id > since).slice(-20);
  res.json({ logs: recent, lastId: saveLogId });
});

/* ── Activity log ────────────────────────────────────── */

router.post('/activity', (req, res) => {
  const user = req.session.user;
  const { action, detail } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });
  getDb().prepare('INSERT INTO activity_log (username, action, detail, ts) VALUES (?,?,?,?)')
    .run(user.username, action, detail || '', Date.now());
  res.json({ ok: true });
});

router.get('/activity', adminOnly, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM activity_log ORDER BY ts DESC LIMIT 100').all();
  res.json({ logs: rows });
});

router.delete('/activity', adminOnly, (req, res) => {
  const { ids, byAction } = req.body || {};
  const db = getDb();
  let deleted = 0;
  if (Array.isArray(ids) && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM activity_log WHERE id IN (${placeholders})`).run(...ids);
    deleted += result.changes;
  }
  if (typeof byAction === 'string' && byAction.length > 0) {
    const result = db.prepare('DELETE FROM activity_log WHERE action = ?').run(byAction);
    deleted += result.changes;
  }
  res.json({ ok: true, deleted });
});

/* ── Server backups ──────────────────────────────────── */

const BACKUP_DIR = process.env.DB_PATH
  ? path.join(path.dirname(process.env.DB_PATH), 'backups')
  : path.join(__dirname, '..', 'backups');

router.get('/backups', adminOnly, (_req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json({ backups: [] });
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: stat.size, time: stat.mtimeMs };
      })
      .sort((a, b) => b.time - a.time)
      .slice(0, 100);
    res.json({ backups: files });
  } catch { res.json({ backups: [] }); }
});

router.get('/backups/:file', adminOnly, (req, res) => {
  const file = path.basename(req.params.file); // prevent path traversal
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'ملف غير موجود' });
  res.download(full, file);
});

router.post('/backups/:file/restore', adminOnly, (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'ملف غير موجود' });
  let content;
  try { content = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { return res.status(400).json({ error: 'ملف تالف' }); }
  if (!content.months) return res.status(400).json({ error: 'صيغة غير صحيحة' });
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO months (key, data, cfg, saved_at, expenses, attendance) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      data=excluded.data, cfg=excluded.cfg, saved_at=excluded.saved_at,
      expenses=excluded.expenses, attendance=excluded.attendance
  `);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM months').run();
    for (const [key, m] of Object.entries(content.months)) {
      insert.run(key, JSON.stringify(m.data), JSON.stringify(m.cfg), m.savedAt || null,
                 m.expenses ? JSON.stringify(m.expenses) : null,
                 m.attendance ? JSON.stringify(m.attendance) : null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

module.exports = router;
module.exports.BACKUP_DIR = BACKUP_DIR;
