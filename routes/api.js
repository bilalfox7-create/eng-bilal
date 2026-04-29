const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

router.use((req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'غير مصرح' });
  next();
});

/* ── Months ─────────────────────────────────────────────── */

router.get('/months', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, data, cfg, saved_at FROM months').all();
  const months = {};
  for (const row of rows) {
    months[row.key] = {
      data:    JSON.parse(row.data),
      cfg:     JSON.parse(row.cfg),
      savedAt: row.saved_at || null,
    };
  }
  res.json({ months });
});

router.put('/months/:key', (req, res) => {
  const { key } = req.params;
  const { data, cfg, savedAt } = req.body;
  if (!data || !cfg) return res.status(400).json({ error: 'بيانات ناقصة' });

  const db = getDb();
  db.prepare(`
    INSERT INTO months (key, data, cfg, saved_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      data     = excluded.data,
      cfg      = excluded.cfg,
      saved_at = excluded.saved_at
  `).run(key, JSON.stringify(data), JSON.stringify(cfg), savedAt || null);

  res.json({ ok: true });
});

router.delete('/months/:key', (req, res) => {
  getDb().prepare('DELETE FROM months WHERE key = ?').run(req.params.key);
  res.json({ ok: true });
});

/* Replace ALL months (import → replace mode) */
router.put('/data', (req, res) => {
  const { months } = req.body;
  if (!months) return res.status(400).json({ error: 'بيانات ناقصة' });

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO months (key, data, cfg, saved_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      data     = excluded.data,
      cfg      = excluded.cfg,
      saved_at = excluded.saved_at
  `);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM months').run();
    for (const [key, m] of Object.entries(months)) {
      insert.run(key, JSON.stringify(m.data), JSON.stringify(m.cfg), m.savedAt || null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.json({ ok: true });
});

/* ── Logo ───────────────────────────────────────────────── */

router.get('/logo', (_req, res) => {
  const row = getDb().prepare("SELECT value FROM app_config WHERE key = 'logo'").get();
  res.json({ logo: row ? row.value : null });
});

router.put('/logo', (req, res) => {
  const { logo } = req.body;
  getDb().prepare(`
    INSERT INTO app_config (key, value) VALUES ('logo', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(logo || null);
  res.json({ ok: true });
});

router.delete('/logo', (_req, res) => {
  getDb().prepare("DELETE FROM app_config WHERE key = 'logo'").run();
  res.json({ ok: true });
});

module.exports = router;
