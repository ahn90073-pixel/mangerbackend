# Backend إدارة Mange (API عامة)

Backend مستقل للوحة إدارة Mange، مبني على **Hono + Cloudflare Workers + Neon PostgreSQL**. يستخدم بيانات المتاجر والمنتجات والطلبات والسدادات المخزنة في قاعدة Tager، مع إبقاء الجداول التجارية داخل tenant schemas.

> **تحذير وصول:** بناءً على اختيار مالك المشروع، كل مسارات الإدارة عامة ولا تتطلب حسابًا أو كلمة مرور أو Bearer token. أي شخص يصل إلى عنوان Worker يستطيع قراءة بيانات التجار والطلبات والعملاء والسدادات وسجل التدقيق، وكذلك اعتماد/رفض المنتجات وتغيير الحالات والعمولات وإنشاء/إلغاء سجلات السداد. قائمة CORS ليست حاجز مصادقة؛ يمكن استدعاء API مباشرةً من أدوات HTTP. لا تضع في هذه القاعدة بيانات لا تريد كشفها للعامة.

## النطاق

- لا توجد شاشة تسجيل دخول أو endpoint لإنشاء حساب. مسارات `/api/admin/auth/*` غير منشورة.
- الجداول المركزية للحسابات والشركات تبقى في `public.users` و`public.companies`؛ بيانات النشاط التجاري تُقرأ من schema الشركة المحدد في `tenant_schema_name`.
- عمليات الإدارة تظل محكومة بالتحقق من المدخلات وحدود حساب السداد، لكنها متاحة لأي زائر دون هوية.
- يُسجل سجل التدقيق `actor_user_id = NULL` للعمليات العامة مع وقت التنفيذ وعنوان IP ووكيل المستخدم؛ قراءة سجل التدقيق نفسها عامة.
- لا ينفذ API تحويلًا ماليًا خارجيًا. إنشاء السداد يسجل سندًا فقط.

## المتطلبات والإعداد

1. يلزم تطبيق migrations الخاصة بمستودع `tagerbackend` رقم **0001 ثم 0002 ثم 0003** على قاعدة Neon نفسها، إضافة إلى migration الإدارة الموصوف أدناه.
2. ثبّت الحزم:
   ```bash
   npm ci
   cp .dev.vars.example .dev.vars
   ```
3. أدخل `DATABASE_URL` في `.dev.vars` محليًا ولا ترفع هذا الملف إلى Git.
4. ضع نطاق الواجهة الفعلي ضمن `ADMIN_CORS_ORIGINS` في `wrangler.toml` أو إعدادات Cloudflare. الإعداد الافتراضي يسمح بمنشأ Vite المحلي وأصول Capacitor (`https://localhost` على Android و`capacitor://localhost` على iOS) و`ionic://localhost`. CORS لا يحمي API من الاستدعاءات المباشرة.
5. شغّل محليًا: `npm run dev`. فحص الصحة: `GET /health`.

## قاعدة البيانات والترحيلات

بعد تطبيق ترحيلات Tager الأساسية 0001–0003، طبّق ترحيل الإدارة على قاعدة اختبار أولًا، ثم على قاعدة الإنتاج بعد المراجعة والنسخة الاحتياطية:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_admin_platform.sql
```

الترحيل idempotent ولا يحذف بيانات التاجر. يضيف `admin_company_settings` و`admin_settlements` و`admin_audit_logs`، وحقول مراجعة المنتجات داخل كل tenant schema، ويسمح بحالة المنتج `rejected`.

## التشغيل والنشر

```bash
npm ci
npm test
npm run lint
npm run build
```

- `build` يستخدم `wrangler deploy --dry-run` ولا ينشر إلى Cloudflare.
- Workflow النشر اليدوي `Deploy Mange admin backend` يستهدف Worker `mangerbackend` ويحتاج GitHub Actions secrets: `DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- يمكن نشر Worker مع `apply_admin_migration=false` دون تغيير قاعدة البيانات. لا تشغّل الترحيل في Production إلا بعد الموافقة عليه صراحةً.

## API العامة

كل المسارات أدناه تحت `/api/admin`، ولا تحتاج `Authorization` أو جلسة. الردود تستخدم `{ "success": true, "message": "…", "data": … }`. القوائم تقبل `page` و`limit` (الحد الأعلى 100).

| المسار | الاستخدام |
|---|---|
| `GET /dashboard` | مؤشرات المبيعات والطلبات والتجار والمنتجات والسدادات، أعلى التجار، وأحدث 5 طلبات |
| `GET /vendors?q=&status=&page=&limit=` | قائمة التجار؛ الحالة: `all`, `active`, `suspended`, `pending_approval` |
| `GET /vendors/:vendorId` | بيانات التاجر وآخر الطلبات والسدادات |
| `PATCH /vendors/:vendorId/status` | تحديث `{ "status": "active" | "suspended" | "pending_approval" }` |
| `PATCH /vendors/:vendorId/commission` | حفظ `{ "type": "percentage" | "fixed", "value": 0 }` |
| `GET /products?status=&q=&vendorId=&page=&limit=` | المنتجات المعلقة/المقبولة/المرفوضة |
| `GET /products/active?olderThanDays=30&vendorId=&q=` | المنتجات المنشورة |
| `PATCH /products/:vendorId/:productId/review` | اعتماد `{ "decision": "approve" }` أو رفض مع `reason` |
| `PATCH /products/:vendorId/:productId/keep` | إبقاء المنتج المنشور |
| `DELETE /products/:vendorId/:productId` | أرشفة المنتج |
| `GET /orders?status=&vendorId=&q=&page=&limit=` | جميع الطلبات عبر مخططات التجار، وتشمل خانة العميل التي قد تعرض الاسم أو البريد أو الهاتف |
| `GET /settlements?status=&vendorId=&q=&page=&limit=` | سجلات السداد |
| `POST /settlements` | إنشاء سند سجل؛ الحقول `vendorId`, `amount`, `period`, `method`, واختياريًا `currency` |
| `PATCH /settlements/:id/status` | إتمام سجل أو إلغاؤه منطقيًا (`completed` أو `void`) |
| `GET /audit-logs?entityType=&action=&q=&page=&limit=` | سجل عام يتضمن البريد المتاح وعناوين IP والتفاصيل |

## الحماية والقيود التقنية

- لا توجد مصادقة أو صلاحيات على مستوى API في وضع التشغيل الحالي؛ لا يعتبر CORS حماية أمنية.
- الاستعلامات عن القيم parameterized، وأسماء tenant schemas تُفحص بتعبير `^tenant_[a-z0-9_]{1,54}$` والجداول بقائمة سماح.
- العمولات والسدادات تخضع لقواعد التحقق والحساب على الخادم، لكن أي زائر يمكنه طلب التغييرات المسموحة عبر المسارات العامة.
- لإعادة حماية API لاحقًا، يجب إعادة مصادقة الخادم وإعادة بوابة الدخول في الواجهة قبل إتاحة أي بيانات حساسة.
