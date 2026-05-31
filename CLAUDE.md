# نظام إدارة مشروعات ليبيا — شركة الرائد للاستشارات الهندسية

دليل المشروع لـ Claude. اقرأه بالكامل قبل أى تعديل. التعليمات دي تتفوّق على أى سلوك افتراضي.

## نظرة عامة
نظام إدارة داخلي لشركة الرائد (ليبيا). بيتتبع المهندسين في 4 محافظات (درنة/البيضاء/بنغازى/طبرق):
**الإعاشة** الشهرية + **الحضور والانصراف** + **العهد والمصروفات** + **إجازات مصر** + **الهيكل التنظيمي** + التقارير.
الواجهة عربية (RTL)، والتعامل مع المستخدم (بلال) باللهجة المصرية.

## النشر (Live)
- **اللينك:** https://el-raed-libya.onrender.com  — على Render (الباقة المجانية، Frankfurt). الخدمة "بتنام" بعد ~15 دقيقة خمول (~50 ثانية لأول طلب).
- **الريبو:** github.com/bilalfox7-create/eng-bilal — Render بينشر تلقائيًا من فرع `main`.
- **قاعدة البيانات:** Turso (libSQL) عبر متغيرين بيئة على Render: `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`. القاعدة منفصلة عن الاستضافة (الداتا آمنة لو الاستضافة اتغيّرت). (التوكن سرّي — مش هنا؛ في الذاكرة الخاصة.)
- **محليًا:** `node server.js` — بيستخدم ملف libSQL محلي (`data-local.db`) لو متغيرات TURSO غير موجودة.
- مستخدمون افتراضيون (db.js): `admin` (admin) · `derna/albaida/benghazi/tobruk` (province) · `mohamed_basyouni/diaa_eldin` (viewer) · `mokhtar` (hr).

## الـ Stack وخريطة الملفات
- **الباك إند:** Express 4 + `@libsql/client` (async).
  - `db.js` — اتصال libSQL + دوال async: `get/all/run/exec/batchWrite` + `initDb()` (إنشاء الجداول + بذر المستخدمين).
  - `routes/auth.js` — login/logout/me/change-password (bcryptjs + sessions + rate limiter).
  - `routes/api.js` — months CRUD، leaves، org-chart، logo، fixed-rents، users، activity، backups. كله async/await. صلاحيات: admin (كامل) / province (تعديل محافظته بس — merge) / viewer+hr (قراءة فقط).
  - `server.js` — إعداد express + static + sessions + routes + `app.get('*')→index.html` + بدء async (`await initDb()` ثم listen) + نسخة احتياطية تلقائية كل 24 ساعة.
- **الفرونت إند:** **ملف واحد** `public/index.html` (~530 ألف حرف). React 18 UMD (بدون JSX) — `h()` = `React.createElement`. كله في `<script>` واحد كبير. خطوط: Cairo + Cormorant Garamond + Bebas Neue.

## نموذج البيانات (جدول `months`)
- `months` مفتاحه `"YYYY-MM"` (+ مفتاح خاص `"leaves"`). كل صف: `{data, cfg, savedAt, expenses, attendance}`.
- `data` = `{ "اسم المحافظة": [ مهندس, ... ] }`. الأسماء: `محافظة درنة` / `محافظة البيضاء` / `محافظة بنغازى` / `محافظة طبرق`.
- **المهندس:** `{id, name, spec, d1, d2, extra?, egyptLeaves?, departedAt?}`. الـ ids: درنة d1..d10 · بيضاء b1..b12(+) · بنغازى g1..g7 · طبرق t1..t3(+).
- **الإعاشة:** `d1` = أيام النصف الأول (0-15)، `d2` = أيام النصف الثاني (0-15)، `extra` = أيام قديمة يدوية. المبلغ = `الأيام × (cfg.rate/30)` بالدولار؛ والجنيه = المبلغ × `cfg.egp`. (دالة `calc()` ~سطر 1785). الافتراضي: `rate=300` (= $10/يوم، $300/شهر)، `egp=52.5`.
- **expenses** = `{custody:[], items:[], transfers:[]}`:
  - عهدة: `{id, desc, source, responsibleId, prov, usd, lyd, egp, date, note}`.
  - مصروف/إيجار: `{id, desc, type:'مصروف'|'إيجار', category, prov, usd, lyd, egp, date, note, custodyId, fixedRentId?}`. الإيجار "مدفوع" فقط لو `type==='إيجار' && fixedRentId===r.id && date===dueDate`.
  - تحويل عملة: `{id, fromCurrency, toCurrency, usd, lyd, egp, rate, date}` — المبلغ بيتقرا من الحقل اللي اسمه نفس العملة.
- **fixed_rents** (app_config): `[{id, desc, day, lyd, usd, prov}]` — قوالب إيجار ثابتة، مستحقة شهريًا في يوم `day`.
- **attendance** = `{ "engId": { "day": {s, in?, out?} } }`. الحالة `s`: `P`=حاضر · `A`=غياب · `AL`=إجازة · `SL`=مرضية · `EG`=فى مصر (خلية يدوية) · `EGL`=إجازة مصر (**محسوبة تلقائيًا من `egyptLeaves` — مش خلية مخزّنة**) · `H`=عطلة · `TXR`=متأخر. الجمعة = عطلة أسبوعية.
- **egyptLeaves** (على المهندس): `[{id, departureDate, returnDate, notes, createdBy, createdAt}]`. في إجازة لو `departureDate <= التاريخ < returnDate` (returnDate = يوم الرجوع، حصري؛ null = مفتوحة). هي اللي بتلوّن خلايا EGL برتقالي.

## ⚠️ قواعد حرجة (التزم بيها)
1. **افحص جافاسكريبت قبل أى رفع/commit لـ index.html.** أى تعريف مكرر (`const`/`let`/`function`) في السكربت الكبير الواحد **بيبيّض الموقع المنشور بالكامل**. الفحص: استخرج محتوى الـ `<script>` و`new Function(body)` — لازم يـ parse نضيف. (دلوقتي مفروض كمان بـ hook قبل الـ push.)
2. **اختبر الموقع Live بعد كل نشر، بـ 3 أدوار** (admin + province + viewer) وبتقرير ✅/⚠️/❌. راعِ الـ cold start (~50 ثانية).
3. **العهدة والمصروفات منفصلتين تمامًا.** العهدة = سجل استلام لكل عملة (رصيد مجمّع). المصروفات بتخصم من الرصيد المجمّع. **ممنوع نهائيًا** أى UI/عمود/قسم "من عهدة" لكل مصروف. "دفعت من جيبك" = رصيد مجمّع سالب (بانر أحمر).
4. **مفيش كشف تلقائي للمستحقات المرحّلة** في كشف الإعاشة — متفحصش الشهور السابقة لـ d1/d2 غير المدفوعة؛ المستخدم بيقرر يدويًا.
5. **3 عملات في كل حتة:** `$` (دولار) · `د.ل` (دينار ليبي) · `ج.م` (جنيه مصري). خليهم التلاتة في الفورمات والجداول والـ PDF والأرصدة.

## الأسلوب والذوق
- تصميم التقارير/الهيكل: **كحلي غامق** (#0A0E1A/#0F2659) + **ذهبي ملكي** (#D4A538) + Cormorant Garamond + Bebas Neue.
- لوحات التحكم/الإكسل: تدرّجات **بنفسجي→وردي** زاهية + كروت KPI + أيقونات (مش كحلي مسطّح). اعرض mockups، وتوقّع تعديلات.
- التقارير (`printOrgPDF`, `exportPDF`...) بتبني HTML string ثم `_openPdfWin`. طباعة A4 + `-webkit-print-color-adjust:exact !important` + `break-inside:avoid`.

## النشر / سير العمل
- commit على فرع الـ worktree ثم `git push origin <branch>:main`. Render بينشر من main.
- استيراد/إصلاح بيانات: PUT `/api/months/:key` (admin، `force:true` لتخطّي حارس الكتابة المدمِّرة) أو PUT `/api/data` (استبدال الكل).
- بعد النشر: hard-reload (Ctrl+Shift+R) أو `?v=` cache-buster، وافحص الـ 3 أدوار.

## تاريخ
انتقل من Railway (مات المجاني، 2026-05) → Render + Turso. إعاشة+مصروفات مايو وحضور أبريل اترجّعوا من PDFs المستخدم واتسجّلوا. تفاصيل في الذاكرة `project_hosting_render_turso`.
