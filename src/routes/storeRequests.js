import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { superAdminGuard } from '../middleware/adminAuth.js';
import { isUuid, pagination, paginated, readJson } from '../lib/validation.js';
import { writeAudit } from '../lib/audit.js';

const storeRequests = new Hono();
const requestStatuses = new Set(['pending', 'approved', 'rejected', 'all']);
const documentTypes = new Set(['nationalId', 'commercialRegister', 'propertyContract']);
const documentExtensions = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

storeRequests.get('/', ...superAdminGuard, async (c) => {
  const status = c.req.query('status') || 'pending';
  if (!requestStatuses.has(status)) return errorResponse('Unsupported store request status.', 400);
  const { page, limit, offset } = pagination(c, 20, 100);
  const db = createDb(c.env);
  const [count] = await db.query(
    `SELECT COUNT(*)::int AS total FROM public.merchant_store_requests
     WHERE (($1::text = 'all' AND status <> 'draft') OR status = $1)`, [status],
  );
  const items = await db.query(
    `SELECT r.id, r.user_id AS "userId", r.email, r.full_name AS "fullName", r.phone,
        r.store_name AS "storeName", r.governorate, r.status, r.admin_note AS "adminNote",
        r.company_id AS "companyId", r.profile_data AS "profileData",
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'documentType', d.document_type, 'contentType', d.content_type,
          'sizeBytes', d.size_bytes, 'uploadedAt', d.uploaded_at
        ) ORDER BY d.document_type) FROM public.merchant_store_request_documents d WHERE d.request_id = r.id), '[]'::jsonb) AS documents,
        r.created_at AS "createdAt", r.reviewed_at AS "reviewedAt"
     FROM public.merchant_store_requests r
     WHERE (($1::text = 'all' AND r.status <> 'draft') OR r.status = $1)
     ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC
     LIMIT $2 OFFSET $3`, [status, limit, offset],
  );
  return jsonResponse(ok(paginated(items, Number(count?.total) || 0, page, limit)));
});

storeRequests.get('/:id/documents/:documentType', ...superAdminGuard, async (c) => {
  const requestId = c.req.param('id');
  const documentType = c.req.param('documentType');
  if (!isUuid(requestId)) return errorResponse('معرّف الطلب غير صالح.', 400);
  if (!documentTypes.has(documentType)) return errorResponse('نوع المستند غير مدعوم.', 400);
  const db = createDb(c.env);
  const [document] = await db`
    SELECT d.content_type, d.document_type, encode(b.file_data, 'base64') AS file_data_base64
    FROM public.merchant_store_request_documents d
    JOIN public.merchant_store_request_document_blobs b ON b.document_id = d.id
    WHERE d.request_id = ${requestId}::uuid AND d.document_type = ${documentType}
    LIMIT 1
  `;
  if (!document?.file_data_base64) return errorResponse('مستند الطلب غير موجود.', 404);
  const binary = atob(document.file_data_base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const extension = documentExtensions[document.content_type] || 'bin';
  const headers = new Headers();
  headers.set('Content-Type', document.content_type);
  headers.set('Content-Disposition', `attachment; filename="${documentType}.${extension}"`);
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(bytes, { status: 200, headers });
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
    if (message.includes('STORE_REQUEST_PROFILE_INCOMPLETE')) return errorResponse('لا يمكن اعتماد الطلب حتى يكتمل الملف التجاري والمستندات الثلاثة.', 409);
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
