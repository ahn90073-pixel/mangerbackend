import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { superAdminGuard } from '../middleware/adminAuth.js';
import { isUuid, pagination, paginated, readJson } from '../lib/validation.js';
import { writeAudit } from '../lib/audit.js';

const storeRequests = new Hono();
const requestStatuses = new Set(['pending', 'approved', 'rejected', 'all']);

storeRequests.get('/', ...superAdminGuard, async (c) => {
  const status = c.req.query('status') || 'pending';
  if (!requestStatuses.has(status)) return errorResponse('Unsupported store request status.', 400);
  const { page, limit, offset } = pagination(c, 20, 100);
  const db = createDb(c.env);
  const [count] = await db.query(
    `SELECT COUNT(*)::int AS total FROM public.merchant_store_requests
     WHERE ($1::text = 'all' OR status = $1)`, [status],
  );
  const items = await db.query(
    `SELECT id, user_id AS "userId", email, full_name AS "fullName", phone,
        store_name AS "storeName", governorate, status, admin_note AS "adminNote",
        company_id AS "companyId", created_at AS "createdAt", reviewed_at AS "reviewedAt"
     FROM public.merchant_store_requests
     WHERE ($1::text = 'all' OR status = $1)
     ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC
     LIMIT $2 OFFSET $3`, [status, limit, offset],
  );
  return jsonResponse(ok(paginated(items, Number(count?.total) || 0, page, limit)));
});

storeRequests.post('/:id/approve', ...superAdminGuard, async (c) => {
  const requestId = c.req.param('id');
  if (!isUuid(requestId)) return errorResponse('Store request ID must be a UUID.', 400);
  const db = createDb(c.env);
  const admin = c.get('adminUser');
  try {
    const [approved] = await db`
      SELECT * FROM public.approve_merchant_store_request(${requestId}::uuid, ${admin.id}::uuid)
    `;
    if (!approved) return errorResponse('تعذر اعتماد الطلب.', 500);
    await writeAudit(db, c, admin.id, 'merchant.store_request.approve', 'merchant_store_request', requestId, {
      companyId: approved.company_id,
      storeName: approved.store_name,
      governorate: approved.governorate,
    });
    return jsonResponse(ok(approved, 'تم اعتماد الطلب وإنشاء المتجر ومساحة بياناته.'));
  } catch (error) {
    const message = String(error?.message || '');
    if (message.includes('STORE_REQUEST_NOT_FOUND')) return errorResponse('طلب المتجر غير موجود.', 404);
    if (message.includes('STORE_REQUEST_NOT_PENDING')) return errorResponse('تمت معالجة هذا الطلب من قبل.', 409);
    if (message.includes('MERCHANT_ALREADY_HAS_STORE')) return errorResponse('يوجد متجر معتمد مرتبط بهذا الحساب بالفعل.', 409);
    if (error?.code === '23505') return errorResponse('تعذر إنشاء المتجر بسبب تعارض في الاسم. راجع البيانات وحاول مرة أخرى.', 409);
    throw error;
  }
});

storeRequests.post('/:id/reject', ...superAdminGuard, async (c) => {
  const requestId = c.req.param('id');
  if (!isUuid(requestId)) return errorResponse('Store request ID must be a UUID.', 400);
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const note = typeof parsed.body.adminNote === 'string' ? parsed.body.adminNote.trim() : '';
  if (note.length > 1000) return errorResponse('ملاحظة الرفض يجب ألا تتجاوز 1000 حرف.', 400);
  const db = createDb(c.env);
  const admin = c.get('adminUser');
  const [request] = await db.query(
    `UPDATE public.merchant_store_requests
     SET status = 'rejected', admin_note = $2, reviewed_by_admin_user_id = $3::uuid,
         reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid AND status = 'pending'
     RETURNING id, user_id AS "userId", email, full_name AS "fullName", phone,
       store_name AS "storeName", governorate, status, admin_note AS "adminNote", reviewed_at AS "reviewedAt"`,
    [requestId, note || null, admin.id],
  );
  if (!request) {
    const [exists] = await db`SELECT id FROM public.merchant_store_requests WHERE id = ${requestId}::uuid`;
    return errorResponse(exists ? 'تمت معالجة هذا الطلب من قبل.' : 'طلب المتجر غير موجود.', exists ? 409 : 404);
  }
  await writeAudit(db, c, admin.id, 'merchant.store_request.reject', 'merchant_store_request', requestId, { adminNote: note || null });
  return jsonResponse(ok(request, 'تم رفض طلب المتجر وإبلاغ مقدم الطلب بالملاحظة.'));
});

export default storeRequests;
