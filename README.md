# Backend إدارة Mange

Backend مستقل للوحة إدارة المتاجر والتجار، مبني على **Hono + Cloudflare Workers + Neon PostgreSQL**. يستخدم هوية المستخدمين والشركات نفسها الموجودة في Backend المتجر `tagerbackend`، لكنه يضيف API منفصلًا للمديرين ومخازن إعدادات العمولات والسدادات وسجل التدقيق.

> لا يحتوي المشروع على بيانات تجريبية أو حساب مدير افتراضي، ولا ينفذ تحويلات بنكية. إنشاء سند السداد هنا يسجل دفعة أكدها المدير خارجيًا فقط.

## نطاق التكامل

- الهوية والصلاحيات تبقى مركزية في `public.users` و`public.company_members`.
- كل تاجر هو شركة في `public.companies`، وتقرأ بيانات نشاطه من `tenant_schema_name` الخاص به؛ لا يقرأ هذا الخادم منتجات التاجر من الجداول العامة القديمة.
- تسجيل الدخول يتطلب أن يكون `users.is_platform_admin = TRUE`. لا يوجد endpoint عام لإنشاء مدير.
- المصادقة Bearer JWT متوافقة مع Tager (`HS256` و`JWT_SECRET` المشترك). هذا الخادم يصدر رمزًا إداريًا لمدة 12 ساعة، ويتحقق من صلاحية المدير من قاعدة البيانات في كل طلب محمي؛ إلغاء امتياز المدير يسري فورًا.
- تهيئة حقول مراجعة المنتجات تتم من migration. كما توجد دالة idempotent تهيئ مخطط أي شركة جديدة عند أول استعمال إداري له.

## المتطلبات والإعداد

1. يلزم أن تكون migrations الخاصة بمستودع `tagerbackend` رقم **0001 ثم 0002 ثم 0003** مطبقة على قاعدة Neon نفسها.
2. ثبّت الحزم:
   ```bash
   npm ci
   cp .dev.vars.example .dev.vars
   ```
3. أدخل `DATABASE_URL` و`JWT_SECRET` الفعليين محليًا في `.dev.vars` (لا ترفع هذا الملف إلى Git). يجب أن يطابق `JWT_SECRET` السر المستخدم في Backend المتجر كي تكون الرموز متوافقة.
4. ضع نطاق الواجهة الفعلي ضمن `ADMIN_CORS_ORIGINS` في `wrangler.toml` أو إعدادات Cloudflare، مفصولًا بفواصل. الإعداد الافتراضي يسمح بمنشأ Vite المحلي وCapacitor فقط.
5. أضف أول مسؤول يدويًا إلى حساب موجود:
   ```bash
   DATABASE_URL='…' node scripts/grant-platform-admin.js admin@example.com --confirm
   ```
   يجب أن يكون البريد تابعًا لحساب موجود في `public.users`. لا تكتب كلمة المرور أو قيمة JWT في ملفات المشروع. استخدم أداة إدارة أسرار موثوقة بدل وضعها في سجل shell عند التشغيل الفعلي.
6. شغّل محليًا: `npm run dev`. فحص الصحة: `GET /health`.

## قاعدة البيانات والترحيلات

بعد تطبيق ترحيلات Tager الأساسية 0001–0003، طبّق ترحيل الإدارة مرة واحدة على **قاعدة اختبار أولًا**، ثم على القاعدة التي ستستخدمها بعد أخذ نسخة احتياطية:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_admin_platform.sql
```

الترحيل idempotent ولا يحذف بيانات التاجر. يضيف `admin_company_settings` و`admin_settlements` و`admin_audit_logs`، ويضيف حقول `rejection_reason`, `reviewed_at`, `reviewed_by`, `published_at`, `admin_kept`, `admin_archived_at` لجدول المنتجات داخل كل tenant schema. كما يسمح بحالة المنتج `rejected` ويحافظ على الحالات السابقة. لا تشغّل الترحيل على Production قبل اختباره ومراجعته.

## تشغيل وفحوصات

```bash
npm ci
npm test
npm run lint
npm run build
```

- `build` يستخدم `wrangler deploy --dry-run` فقط؛ لا ينشر إلى Cloudflare.
- يوجد Workflow نشر يدوي `Deploy Mange admin backend` يستهدف Worker `mangerbackend`. يحتاج أسرار GitHub `DATABASE_URL`, `JWT_SECRET`, `CLOUDFLARE_API_TOKEN`, و`CLOUDFLARE_ACCOUNT_ID`، ولا يطلب قيمها عبر المحادثة.
- يشغّل Workflow ترحيل الإدارة بعد اختيار `apply_admin_migration=true` فقط. الترحيل يضيف جداول وحقول مراجعة وسجل تدقيق إلى قاعدة المتجر، لذا اختبره وخذ نسخة احتياطية قبل الموافقة على تشغيله في Production.
- اضبط قائمة `ADMIN_CORS_ORIGINS` في إعداد Worker لتشمل نطاق واجهة Mange الفعلي. لا توجد بيانات أو أسرار إنتاج داخل المستودع.

## API

كل المسارات أدناه تحت `/api/admin`. الردود تستخدم `{ "success": true, "message": "…", "data": … }`، وكل المسارات عدا `auth/login` تتطلب `Authorization: Bearer <token>` لمدير صالح. القوائم تقبل `page` و`limit` (الحد الأعلى 100).

| المسار | الاستخدام |
|---|---|
| `POST /auth/login` | دخول مدير بحقول `{ "email", "password" }` |
| `GET /auth/me` | بيانات المدير الحالي والتحقق من الرمز |
| `GET /dashboard` | مؤشرات المبيعات والطلبات والتجار والمنتجات والسدادات، أعلى التجار، وأحدث 5 طلبات |
| `GET /vendors?q=&status=&page=&limit=` | قائمة التجار. `status`: `all`, `active`, `suspended`, `pending_approval` |
| `GET /vendors/:vendorId` | بيانات التاجر مع آخر 10 طلبات وآخر 50 سندًا |
| `PATCH /vendors/:vendorId/status` | تحديث `{ "status": "active" | "suspended" | "pending_approval" }` |
| `PATCH /vendors/:vendorId/commission` | حفظ `{ "type": "percentage" | "fixed", "value": 0 }`؛ النسبة من 0 إلى 100 |
| `GET /products?status=&q=&vendorId=&page=&limit=` | مراجعة المنتجات. الحالات: `pending`, `approved`, `rejected`, `active`, `all` |
| `GET /products/active?olderThanDays=30&vendorId=&q=` | المنتجات المنشورة، ويمكن قصرها على الأقدم من عدد أيام معين |
| `PATCH /products/:vendorId/:productId/review` | اعتماد `{ "decision": "approve" }` أو رفض `{ "decision": "reject", "reason": "…" }` |
| `PATCH /products/:vendorId/:productId/keep` | إبقاء المنتج المنشور في القائمة |
| `DELETE /products/:vendorId/:productId` | أرشفة المنتج بدل الحذف الفيزيائي كي لا تنكسر الطلبات السابقة |
| `GET /orders?status=&vendorId=&q=&page=&limit=` | بحث وتصفية الطلبات عبر tenant schemas |
| `GET /settlements?status=&vendorId=&q=&page=&limit=` | قائمة السدادات؛ `all` يخفي الملغاة، ويمكن طلب `status=void` صراحةً |
| `POST /settlements` | إنشاء سجل سداد؛ الحقول `vendorId`, `amount`, `period`, `method`, واختياريًا `currency` |
| `PATCH /settlements/:id/status` | إتمام سند معلّق أو إلغاؤه منطقيًا (`completed` أو `void`) |
| `GET /audit-logs?entityType=&action=&q=&page=&limit=` | سجل تغييرات المسؤولين ومعلومات المنفذ |

مثال إنشاء سند:

```json
{
  "vendorId": "UUID-الشركة",
  "amount": 1250,
  "period": "أكتوبر 2026",
  "method": "تحويل بنكي",
  "currency": "EGP"
}
```

الخادم هو مصدر الحساب: يعيد/يسجل مبلغ العمولة والصافي، وينشئ مرجعًا فريدًا. أنواع طرق الدفع التي يستخدمها الواجهة الحالية (تحويل بنكي، شيك، إيداع نقدي) نصوص مقبولة. إنشاء السند بحالة `completed` يعني أن المسؤول سجّل دفعة تم تنفيذها خارجيًا؛ لا يوجد تكامل دفع.

## حقول الواجهة وملاحظات التكامل

الـAPI يرجع أسماء الحقول التي تحتاجها الشاشات مثل `companyName`, `merchantName`, `totalSales`, `totalOrders`, `commissionType`, `commissionValue`, `settledAmount`, `pendingProducts`، ويستخدم UUID الحقيقي للتاجر والمنتج والطلب بدل معرّفات Mock مثل `VND-001`. صفحات Mange الحالية ما زالت تقرأ `mockData`؛ يلزم ربط `DashboardContext` بطلبات هذا الـAPI لاستخدام بيانات Production.

قاعدة المتجر الحالية افتراضيًا تستخدم `EGP`، بينما أداة تنسيق الواجهة الحالية تعرض `SAR`. يرسل API رمز العملة، لكن يجب توحيد عملة قاعدة البيانات وتنسيق الواجهة قبل الاعتماد المالي. حقل المدينة غير موجود في سجل الشركة/المالك المركزي الحالي ويرجع `null` إلى أن يضاف مصدر موثوق له.

إعداد العمولة الثابتة يحافظ على النموذج الحالي في Mange: قيمة ثابتة واحدة عند احتساب الرصيد/السند، وليست مضروبة بعدد الطلبات. غيّر ذلك بالتزامن في الواجهة والسياسة المالية إذا كانت نية العمل مختلفة.

## الحماية والسجل

- كلمات المرور لا تُعاد من API. كلمة المرور تتحقق عبر bcrypt، وJWT قصير الصلاحية.
- جميع الاستعلامات عن القيم parameterized. أسماء tenant schema تأتي من قاعدة البيانات وتُفحص بتعبير `^tenant_[a-z0-9_]{1,54}$`، والجداول محددة بقائمة سماح.
- تغييرات الحالة والعمولات ومراجعة المنتجات والسدادات تسجل في `public.admin_audit_logs`.
- لا تحفظ أسرارًا أو رموزًا أو كلمات مرور في Git أو `.env` المرفوع. استخدم أسرار Cloudflare/GitHub عند النشر.
