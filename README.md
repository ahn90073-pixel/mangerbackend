# Backend إدارة Mange

واجهة API للوحة إدارة المتاجر، مبنية باستخدام **Hono وCloudflare Workers وNeon PostgreSQL**. تتطلب جميع مسارات الإدارة مصادقة Bearer؛ والاستثناءات العامة هي `GET /health` و`POST /api/admin/auth/login` للموظفين و`POST /api/admin/auth/firebase-login` للأدمن العام.

## الأدوار ونطاق البيانات

- **`super_admin`**: يرى جميع التجار والطلبات، ويمكنه إدارة الموظفين وتعيين محافظة للتاجر ومراجعة المنتجات والعمولات والسدادات وسجل التدقيق. يسجل الدخول عبر Firebase Email/Password فقط؛ يتحقق الخادم من Firebase ثم يربط البريد المصرح به بدور محفوظ في Neon. يسمح النظام بحد أقصى ثلاثة أدمن عامين.
- **`employee`**: يرى التجار والطلبات التابعين للمحافظات المسندة إلى حسابه، ويمكنه تعديل حالة تاجر أو تحديث طلب داخل هذه المحافظات. لا يصل إلى مراجعة المنتجات أو العمولات أو السدادات أو سجل التدقيق أو إدارة الموظفين.
- تسجيل الدخول إلى Firebase وحده لا يمنح صلاحية أدمن. يجب أن يكون البريد موثقًا وموجودًا في `FIREBASE_ADMIN_EMAILS`، ثم ينشئه الخادم أو يربطه في Neon. الأدوار والصلاحيات مصدرها Neon.
- يطبّق الخادم النطاق على استعلامات القراءة والتحديث؛ إخفاء الروابط في React ليس حاجز الصلاحيات.
- يعتمد نطاق الطلب على **محافظة التاجر** (`public.companies.governorate`) لا على محافظة عنوان الشحن. لذلك يرى الموظف طلبات تجار محافظاته حتى إن كان عنوان تسليم أحد الطلبات في محافظة أخرى.
- الشركات القديمة تبدأ بمحافظة غير محددة ولا تظهر للموظفين إلى أن يعيّن الأدمن العام المحافظة من صفحة تفاصيل التاجر. لا تُجرى تعبئة تلقائية قد تنسب تاجرًا إلى محافظة خاطئة.

## تشغيل الترحيلات والحساب الأول

يجب تطبيق ترحيلات Tager `0001` إلى `0004` على Neon أولًا، ثم ترحيلات لوحة الإدارة بهذا الترتيب:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_admin_platform.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0002_admin_auth_governorates.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0003_firebase_super_admin_auth.sql
```

الترحيلات إضافية وقابلة لإعادة التشغيل؛ تنشئ `public.admin_users`، وتضيف محافظة الشركة وروابط تدقيق منفصلة لحسابات الإدارة، وتحدث جداول مراجعة المنتجات في مخططات التجار الحالية. الترحيل `0003` يضيف ربط Firebase وسجل فتحات يفرض سقف ثلاثة أدمن. لا تحذف الترحيلات بيانات التجار أو الطلبات.

يُنشأ حساب الأدمن العام أو يُربط بحساب Firebase عند أول تسجيل دخول ناجح، بشرط أن يكون بريده ضمن `FIREBASE_ADMIN_EMAILS`. لا يوجد إنشاء حسابات من شاشة Firebase داخل اللوحة ولا تُمنح صلاحية أدمن تلقائيًا لأي مستخدم.

فعّل **Email/Password** في Firebase Authentication، وأنشئ حسابات الأدمن هناك، ثم تحقق من البريد الإلكتروني لكل حساب. جهّز الأسرار التالية في GitHub Actions وCloudflare Worker:

- `FIREBASE_WEB_API_KEY` و`FIREBASE_PROJECT_ID` من إعدادات مشروع Firebase.
- `FIREBASE_ADMIN_EMAILS`: عناوين البريد المسموح بها مفصولة بفواصل، بحد أقصى ثلاثة.
- `INITIAL_ADMIN_EMAIL` و`INITIAL_ADMIN_PASSWORD`: بيانات أول حساب Firebase لاختبار الدخول بعد النشر.
- إلى جانبها `DATABASE_URL` و`ADMIN_JWT_SECRET` و`CLOUDFLARE_API_TOKEN` و`CLOUDFLARE_ACCOUNT_ID`.

قيم إعداد واجهة Firebase (`apiKey`, `authDomain`, `projectId`, `appId`) توضع في متغيرات Vite العامة `VITE_FIREBASE_*` في بيئة بناء الواجهة. مفتاح Firebase web API ليس كلمة مرور؛ لا تضع service-account JSON أو private key في الواجهة.

## إعداد الأسرار

أنشئ قيمة عشوائية مستقلة لتوقيع الجلسات، ولا تستخدم كلمة مرور الأدمن أو قيمة `DATABASE_URL` لهذا الغرض. مثال للتوليد:

```bash
openssl rand -base64 48
```

أضف القيمة باسم `ADMIN_JWT_SECRET`، واحتفظ أيضًا بـ`DATABASE_URL` و`FIREBASE_WEB_API_KEY` و`FIREBASE_PROJECT_ID` و`FIREBASE_ADMIN_EMAILS` في أسرار Cloudflare Worker. عند استخدام Workflow النشر اليدوي، أضف هذه القيم إلى GitHub Actions secrets مع `INITIAL_ADMIN_EMAIL` و`INITIAL_ADMIN_PASSWORD` لاختبار تسجيل الدخول، و`CLOUDFLARE_API_TOKEN` و`CLOUDFLARE_ACCOUNT_ID`. لا تُسجل كلمات المرور أو الأسرار في Git. مدة رمز الدخول 8 ساعات، ويتحقق الخادم من حالة الحساب والدور والمحافظات من Neon في كل طلب. إيقاف الموظف يرفع `token_version` فيبطل جلساته القائمة.

محليًا، املأ `.dev.vars` ثم شغّل:

```bash
npm run dev
```

لا يتصل إعداد branch previews بقاعدة الإنتاج ولا يملك سر توقيع؛ لذلك لا تسجل الدخول إلى preview إلا بعد تجهيز أسرار اختبار مستقلة.

## مسارات API

جميع المسارات التالية تبدأ بـ`/api/admin`، وتحتاج `Authorization: Bearer <token>` ما عدا تسجيل الدخول.

| المسار | الصلاحية | الوظيفة |
|---|---|---|
| `POST /auth/login` | عام | تسجيل دخول الموظفين بالبريد وكلمة المرور وإصدار رمز محدود بثماني ساعات |
| `POST /auth/firebase-login` | عام | التحقق من Firebase ID token وربط الأدمن المصرح به في Neon وإصدار رمز لوحة الإدارة |
| `GET /auth/me` | أي مستخدم مسجل | ملف الحساب والدور والمحافظات |
| `POST /auth/logout` | أي مستخدم مسجل | إنهاء جلسة الواجهة؛ يحذف العميل الرمز. ينتهي الرمز أيضًا بعد 8 ساعات |
| `GET /dashboard` | أدمن أو موظف | المؤشرات والطلبات ضمن نطاق المستخدم |
| `GET /vendors` و`GET /vendors/:id` | أدمن أو موظف | قائمة وتفاصيل التجار؛ الموظف لا يتجاوز محافظاته ولا يرى حقول المالية |
| `PATCH /vendors/:id/status` | أدمن أو موظف ضمن النطاق | تحديث حالة تاجر مصرح به |
| `PATCH /vendors/:id/governorate` | أدمن عام | تعيين أو تغيير محافظة التاجر |
| `GET /orders` و`GET /orders/:vendorId/:orderId` | أدمن أو موظف ضمن النطاق | قائمة الطلبات وتفاصيلها |
| `PATCH /orders/:vendorId/:orderId` | أدمن أو موظف ضمن النطاق | تحديث حالة الطلب والشحنة ورسومها |
| `GET /employees` | أدمن عام | قائمة الموظفين ومحافظاتهم وحالة الحساب |
| `POST /employees` | أدمن عام | إنشاء موظف بالاسم والبريد وكلمة المرور ومحافظة واحدة على الأقل |
| `PATCH /employees/:id/status` | أدمن عام | تفعيل أو إيقاف موظف وإبطال جلساته |
| `GET /products*`, `PATCH /products*`, `DELETE /products*` | أدمن عام | مراجعة المنتجات وإدارتها |
| `GET /settlements*`, `POST /settlements`, `PATCH /settlements*` | أدمن عام | إدارة السدادات المالية |
| `GET /audit-logs` | أدمن عام | قراءة سجل التدقيق |

كلمة مرور الموظف يجب أن تكون 12 محرفًا على الأقل. تُطابق المحافظات قائمة مصر المعتمدة، ويُرفض إنشاء موظف من دون محافظة واحدة على الأقل أو تمرير اسم محافظة غير معروف. يمكن إضافة موظفين من لوحة الإدارة؛ سقف الثلاثة يخص حسابات `super_admin` فقط.

## التحقق والنشر

```bash
npm ci
npm test
npm run lint
npm run build
```

`build` يستخدم `wrangler deploy --dry-run` ولا ينشر. Workflow النشر في GitHub يدوي فقط. إذا فُعّل خيار تطبيق الترحيلات فإنه يطبق `0001_admin_platform.sql` ثم `0002_admin_auth_governorates.sql` و`0003_firebase_super_admin_auth.sql` قبل النشر؛ راجع نسخة قاعدة البيانات وخطة الترحيل قبل تشغيله على الإنتاج.
