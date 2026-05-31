#!/usr/bin/env node
/* فحص أمان: يتأكد إن السكربت الكبير جوّه public/index.html بيـ parse نضيف.
   أى تعريف مكرر (const/let/function) بيبيّض الموقع المنشور بالكامل، فده بيمنعه.
   آمن (fail-open): لو مقدرش يقرا الملف أو يلاقي السكربت، بيسمح بالـ commit. */
const fs = require('fs');
const path = require('path');

let html;
try {
  html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
} catch (_) { process.exit(0); } // مفيش ملف هنا → اسمح

const lines = html.split('\n');
let s = -1, e = -1;
for (let i = 0; i < lines.length; i++) {
  if (s < 0 && lines[i].includes('<script>') && !lines[i].includes('src=')) s = i + 1;
  else if (s >= 0 && lines[i].includes('</script>')) { e = i; break; }
}
if (s < 0 || e < 0) process.exit(0); // ملقيتش السكربت → اسمح

try {
  new Function(lines.slice(s, e).join('\n'));
  process.exit(0); // ✅ سليم
} catch (err) {
  console.error('\n🛑 اتمنع الـ commit: public/index.html فيه خطأ JavaScript هيبيّض الموقع!');
  console.error('   ' + err.message);
  console.error('   صلّح الخطأ ده الأول (غالبًا تعريف مكرر). [فحص أمان تلقائي — CLAUDE.md قاعدة #1]\n');
  process.exit(1); // ❌ يوقف الـ commit
}
