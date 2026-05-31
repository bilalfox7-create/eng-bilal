/* ──────────────────────────────────────────────────────────────
   نسخة احتياطية تلقائية على GitHub (عبر Contents API).
   بترفع كل بيانات جدول months في ملف backup-latest.json في ريبو خاص.
   git history بيحتفظ بكل النسخ القديمة تلقائيًا.

   التفعيل: متغيرين بيئة على Render
     GITHUB_BACKUP_TOKEN = توكن GitHub (fine-grained: Contents read/write على ريبو النسخ)
     GITHUB_BACKUP_REPO  = "owner/repo"  (مثال: bilalfox7-create/eng-bilal-backups)
   لو المتغيرين مش موجودين → بيتجاهل بهدوء (skipped).
   ────────────────────────────────────────────────────────────── */
const { all } = require('./db');

async function buildMonthsJson() {
  const rows = await all('SELECT key, data, cfg, saved_at, expenses, attendance FROM months');
  const months = {};
  for (const r of rows) {
    if (r.key === 'leaves') {
      months[r.key] = JSON.parse(r.data);
    } else {
      months[r.key] = {
        data:       JSON.parse(r.data),
        cfg:        JSON.parse(r.cfg),
        savedAt:    r.saved_at || null,
        expenses:   r.expenses   ? JSON.parse(r.expenses)   : null,
        attendance: r.attendance ? JSON.parse(r.attendance) : null,
      };
    }
  }
  return months;
}

let lastPush = 0;
const THROTTLE_MS = 5 * 60 * 1000; // على الأكثر مرة كل 5 دقائق (إلا لو force)

async function backupToGitHub({ force = false } = {}) {
  const token = process.env.GITHUB_BACKUP_TOKEN;
  const repo  = process.env.GITHUB_BACKUP_REPO;
  if (!token || !repo) return { skipped: 'not-configured' };
  if (!force && Date.now() - lastPush < THROTTLE_MS) return { skipped: 'throttled' };

  const months = await buildMonthsJson();
  const api = `https://api.github.com/repos/${repo}/contents/backup-latest.json`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'el-raed-backup',
  };

  // محتاجين sha الملف الحالي عشان نعمل update (لو موجود)
  let sha;
  try {
    const g = await fetch(api, { headers });
    if (g.ok) sha = (await g.json()).sha;
  } catch (_) { /* أول مرة: مفيش ملف */ }

  const payload = { backedUpAt: new Date().toISOString(), monthsCount: Object.keys(months).length, months };
  const content = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64');
  const res = await fetch(api, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message: `backup ${new Date().toISOString()}`, content, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
  lastPush = Date.now();
  return { ok: true, months: Object.keys(months).length };
}

module.exports = { backupToGitHub, buildMonthsJson };
