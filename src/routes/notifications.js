import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { superAdminGuard } from '../middleware/adminAuth.js';
import { isUuid, pagination, readJson } from '../lib/validation.js';
import { isFcmConfigured, sendFcmNotification, uploadFirebaseNotificationImage } from '../lib/fcm.js';
import { writeAudit } from '../lib/audit.js';

const notifications = new Hono();
const audiences = new Set(['merchant', 'customer']);
const MAX_TOKENS_PER_SEND = 500;

function validateCampaign(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['بيانات الحملة غير صالحة.'];
  if (!audiences.has(body.audience)) errors.push('الجمهور يجب أن يكون merchant أو customer.');
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120) errors.push('عنوان الإشعار مطلوب وبحد أقصى 120 حرفًا.');
  if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > 500) errors.push('نص الإشعار مطلوب وبحد أقصى 500 حرف.');
  if (body.companyId !== undefined && body.companyId !== null && !isUuid(body.companyId)) errors.push('معرّف المتجر غير صالح.');
  if (body.imageData !== undefined && body.imageData !== null && (typeof body.imageData !== 'string' || body.imageData.length > 2_100_000)) errors.push('صورة الإشعار غير صالحة أو حجمها أكبر من 1.5 ميجابايت.');
  return errors;
}

function safeAudit(db, c, action, details) {
  return writeAudit(db, c, c.get('adminUser')?.id ?? null, action, 'notification', action, details)
    .catch(() => undefined);
}

notifications.get('/status', ...superAdminGuard, async (c) => {
  const db = createDb(c.env);
  const rows = await db.query(
    `WITH source_counts AS (
       SELECT n.audience,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE n.push_enabled IS TRUE)::int AS opted_in,
         COUNT(*) FILTER (WHERE n.fcm_token IS NOT NULL AND n.fcm_token <> '')::int AS with_token,
         COUNT(*) FILTER (WHERE n.push_enabled IS TRUE AND n.fcm_token IS NOT NULL AND n.fcm_token <> '')::int AS ready_to_send
       FROM public.notification_contacts n
       WHERE n.audience IN ('merchant', 'customer')
         AND (n.audience <> 'customer' OR n.fcm_token IS NULL OR NOT EXISTS (
           SELECT 1 FROM app.device_tokens d WHERE d.company_id IS NULL AND d.token = n.fcm_token
         ))
       GROUP BY n.audience
       UNION ALL
       SELECT 'customer'::text AS audience,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE enabled IS TRUE)::int AS opted_in,
         COUNT(*) FILTER (WHERE token IS NOT NULL AND token <> '')::int AS with_token,
         COUNT(*) FILTER (WHERE enabled IS TRUE AND token IS NOT NULL AND token <> '')::int AS ready_to_send
       FROM app.device_tokens
       WHERE company_id IS NULL
     )
     SELECT audience, SUM(total)::int AS total, SUM(opted_in)::int AS opted_in,
       SUM(with_token)::int AS with_token, SUM(ready_to_send)::int AS ready_to_send
     FROM source_counts
     GROUP BY audience
     ORDER BY audience`,
  );
  const byAudience = { merchant: { total: 0, optedIn: 0, withToken: 0, readyToSend: 0 }, customer: { total: 0, optedIn: 0, withToken: 0, readyToSend: 0 } };
  for (const row of rows) {
    byAudience[row.audience] = {
      total: Number(row.total || 0),
      optedIn: Number(row.opted_in || 0),
      withToken: Number(row.with_token || 0),
      readyToSend: Number(row.ready_to_send || 0),
    };
  }
  return jsonResponse(ok({
    configured: {
      merchant: isFcmConfigured(c.env, 'taget'),
      customer: isFcmConfigured(c.env, 'online-store'),
    },
    audiences: byAudience,
  }));
});

notifications.get('/contacts', ...superAdminGuard, async (c) => {
  const db = createDb(c.env);
  const audience = c.req.query('audience') || null;
  const companyId = c.req.query('companyId') || null;
  if (audience && !audiences.has(audience)) return errorResponse('الجمهور غير صالح.', 400);
  if (companyId && !isUuid(companyId)) return errorResponse('معرّف المتجر غير صالح.', 400);
  const { page, limit, offset } = pagination(c, 50, 100);
  const values = [audience, companyId, limit, offset];
  const rows = await db.query(
    `WITH contacts AS (
       SELECT n.company_id, n.audience, n.whatsapp_phone, n.platform, n.app_version, n.last_seen_at,
         n.location_city, n.location_region, n.location_country, n.fcm_token, n.push_enabled,
         u.full_name AS contact_name, c.display_name AS store_name
       FROM public.notification_contacts n
       LEFT JOIN public.companies c ON c.id = n.company_id
       LEFT JOIN public.users u ON u.id = n.user_id
       WHERE ($1::text IS NULL OR n.audience = $1::text)
         AND ($2::uuid IS NULL OR n.company_id = $2::uuid)
         AND (n.audience <> 'customer' OR n.fcm_token IS NULL OR NOT EXISTS (
           SELECT 1 FROM app.device_tokens d WHERE d.company_id IS NULL AND d.token = n.fcm_token
         ))
       UNION ALL
       SELECT d.company_id, 'customer'::text AS audience,
         COALESCE(customer.phone, u.phone) AS whatsapp_phone, d.platform, d.app_version, d.last_seen_at,
         d.location_city, d.location_region, d.location_country, d.token AS fcm_token, d.enabled AS push_enabled,
         COALESCE(u.full_name, customer.full_name) AS contact_name, c.display_name AS store_name
       FROM app.device_tokens d
       LEFT JOIN app.customers customer ON customer.id = d.customer_id
       LEFT JOIN app.users u ON u.id = d.user_id
       LEFT JOIN app.companies c ON c.id = d.company_id
       WHERE d.company_id IS NULL
         AND ($1::text IS NULL OR $1::text = 'customer')
         AND ($2::uuid IS NULL OR d.company_id = $2::uuid)
     )
     SELECT company_id, audience, whatsapp_phone, platform, app_version, last_seen_at,
       location_city, location_region, location_country,
       CASE WHEN fcm_token IS NOT NULL AND fcm_token <> '' THEN CONCAT(LEFT(fcm_token, 8), '…', RIGHT(fcm_token, 6)) ELSE NULL END AS token_hint,
       (fcm_token IS NOT NULL AND fcm_token <> '') AS has_push_token,
       COALESCE(push_enabled, FALSE) AS push_enabled,
       contact_name, store_name,
      COUNT(*) OVER()::int AS _total
     FROM contacts
     ORDER BY store_name NULLS LAST, audience, whatsapp_phone, contact_name
     LIMIT $3 OFFSET $4`,
    values,
  );
  const total = rows.length ? Number(rows[0]._total || 0) : 0;
  return jsonResponse(ok({
    items: rows.map((row) => ({
      name: row.contact_name || (row.audience === 'customer' ? 'عميل' : 'تاجر'),
      storeName: row.store_name || '—',
      audience: row.audience,
      companyId: row.company_id,
      whatsappPhone: row.whatsapp_phone || '—',
      platform: row.platform || '—',
      appVersion: row.app_version || '—',
      lastSeenAt: row.last_seen_at,
      locationCity: row.location_city || null,
      locationRegion: row.location_region || null,
      locationCountry: row.location_country || null,
      tokenHint: row.token_hint || '—',
      hasPushToken: Boolean(row.has_push_token),
      pushEnabled: Boolean(row.push_enabled),
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }));
});

notifications.post('/send', ...superAdminGuard, async (c) => {
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const errors = validateCampaign(parsed.body);
  if (errors.length) return errorResponse('يرجى مراجعة بيانات الحملة.', 400, errors);

  const { audience, title, body, companyId = null, imageData = null, imageName = 'notification-image' } = parsed.body;
  const appName = audience === 'customer' ? 'online-store' : 'taget';
  if (!isFcmConfigured(c.env, appName)) {
    const secretName = audience === 'customer' ? 'FCM_PUBLIC_SERVICE_ACCOUNT_JSON' : 'FCM_SERVICE_ACCOUNT_JSON';
    return errorResponse(`${secretName} غير مهيأ؛ أضف اعتماد Firebase الخاص بهذا التطبيق قبل الإرسال.`, 503);
  }
  let imageUrl = null;
  if (imageData) {
    try {
      imageUrl = await uploadFirebaseNotificationImage(c.env, imageData, imageName, appName);
      if (!imageUrl) return errorResponse('تعذر تجهيز صورة الإشعار؛ استخدم PNG أو JPG أو WEBP بحجم أقل من 1.5 ميجابايت.', 400);
    } catch {
      return errorResponse('تعذر رفع صورة الإشعار إلى Firebase Storage.', 502);
    }
  }
  const db = createDb(c.env);
  const rows = await db.query(
    `WITH candidates AS (
       SELECT fcm_token
       FROM public.notification_contacts
       WHERE audience = $1::text
         AND app_name = $2::text
         AND push_enabled IS TRUE
         AND fcm_token IS NOT NULL AND fcm_token <> ''
         AND ($3::uuid IS NULL OR company_id = $3::uuid)
       UNION
       SELECT d.token AS fcm_token
       FROM app.device_tokens d
       WHERE $1::text = 'customer'
         AND $2::text = 'online-store'
         AND d.company_id IS NULL
         AND d.enabled IS TRUE
         AND d.token IS NOT NULL AND d.token <> ''
         AND $3::uuid IS NULL
     )
     SELECT DISTINCT fcm_token FROM candidates
     WHERE fcm_token IS NOT NULL AND fcm_token <> ''
     LIMIT ${MAX_TOKENS_PER_SEND}`,
    [audience, appName, companyId],
  );
  const tokens = rows.map((row) => row.fcm_token).filter(Boolean);
  const result = await sendFcmNotification(c.env, tokens, { title: title.trim(), body: body.trim(), imageUrl, appName });
  const summary = { audience, companyId, total: tokens.length, sent: result.sent, failed: result.failed };
  await safeAudit(db, c, 'notification.send', summary);
  return jsonResponse(ok(summary, result.failed ? 'اكتمل الإرسال مع وجود إخفاقات.' : 'تم إرسال الإشعار.'));
});

export default notifications;
