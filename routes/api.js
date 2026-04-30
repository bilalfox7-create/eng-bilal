const express = require('express');
const bcrypt  = require('bcryptjs');
const { getDb } = require('../db');

const router = express.Router();

/* ── Auth guard ──────────────────────────────────────── */
router.use((req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'غير مصرح' });
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
    months[row.key] = {
      data:       JSON.parse(row.data),
      cfg:        JSON.parse(row.cfg),
      savedAt:    row.saved_at || null,
      expenses:   row.expenses   ? JSON.parse(row.expenses)   : null,
      attendance: row.attendance ? JSON.parse(row.attendance) : null,
    };
  }
  res.json({ months });
});

router.put('/months/:key', (req, res) => {
  const { key } = req.params;
  const user = req.session.user;
  const db   = getDb();

  /* ── Province user: merge-only update ── */
  if (user.role === 'province') {
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

    // Only update attendance for engineers in their province
    for (const [engId, attData] of Object.entries(inAtt)) {
      if (provEngIds.has(engId)) {
        existingAtt[engId] = attData;
      }
    }

    db.prepare('UPDATE months SET data = ?, attendance = ? WHERE key = ?')
      .run(JSON.stringify(existingData), JSON.stringify(existingAtt), key);

    return res.json({ ok: true });
  }

  /* ── Admin: full update ── */
  const { data, cfg, savedAt, expenses, attendance } = req.body;
  if (!data || !cfg) return res.status(400).json({ error: 'بيانات ناقصة' });

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

/* ── User management — admin only ───────────────────── */

router.get('/users', adminOnly, (_req, res) => {
  const users = getDb()
    .prepare("SELECT id, username, role, province FROM users WHERE role = 'province' ORDER BY province")
    .all();
  res.json({ users });
});

router.put('/users/:id/password', adminOnly, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  const hash = bcrypt.hashSync(password, 10);
  const result = getDb()
    .prepare("UPDATE users SET password = ? WHERE id = ? AND role = 'province'")
    .run(hash, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ ok: true });
});

module.exports = router;
