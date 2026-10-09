import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { EGYPT_GOVERNORATES, normalizeGovernorate } from '../lib/governorates.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { adminGuard, superAdminGuard } from '../middleware/adminAuth.js';
import { assignedGovernorates, isSuperAdmin } from '../lib/access.js';
import { getVendorSummaries, redactVendorFinance } from '../services/vendorService.js';
import { listAdminOrders } from '../services/orderService.js';
import { pagination, paginated, readJson, searchTerm, isUuid, isMoney } from '../lib/validation.js';
import { writeAudit } from '../lib/audit.js';

const vendors = new Hono();
const vendorStatuses = new Set(['active', 'suspended', 'pending_approval']);

vendors.get('/', ...adminGuard, async (c) => {
  const user = c.get('adminUser');
  const rows = await getVendorSummaries(createDb(c.env), null, assignedGovernorates(user));
  const q = searchTerm(c.req.query('q')).toLocaleLowerCase();
  const status = c.req.query('status') || 'all';
  if (status !== 'all' && !vendorStatuses.has(status)) return errorResponse('Unsupported vendor status.', 400);
  const filtered = rows.filter((vendor) => {
    const matchesQuery = !q || [vendor.companyName, vendor.merchantName, vendor.id].some((value) => String(value || '').toLocaleLowerCase().includes(q));
    return matchesQuery && (status === 'all' || vendor.status === status);
  });
  const { page, limit, offset } = pagination(c, 20, 100);
  const items = filtered.slice(offset, offset + limit).map((vendor) => (
    isSuperAdmin(user) ? vendor : redactVendorFinance(vendor)
  ));
  return jsonResponse(ok(paginated(items, filtered.length, page, limit)));
});

vendors.get('/:id', ...adminGuard, async (c) => {
  const companyId = c.req.param('id');
  if (!isUuid(companyId)) return errorResponse('Vendor ID must be a UUID.', 400);
  const db = createDb(c.env);
  const user = c.get('adminUser');
  const [vendor] = await getVendorSummaries(db, companyId, assignedGovernorates(user));
  if (!vendor) return errorResponse('Vendor not found.', 404);
  const [settlements, orders] = await Promise.all([
    isSuperAdmin(user) ? db.query(
      `SELECT id, company_id AS "vendorId", amount::numeric AS amount,
        commission_amount::numeric AS "commissionDeducted", net_amount::numeric AS "netAmount",
        currency, period, paid_at AS date, status, method, reference
       FROM public.admin_settlements WHERE company_id = $1::uuid ORDER BY created_at DESC LIMIT 50`,
      [companyId],
    ) : Promise.resolve([]),
    listAdminOrders(db, {
      companyId, page: 1, limit: 10, offset: 0, governorates: assignedGovernorates(user),
    }),
  ]);
  const safeVendor = isSuperAdmin(user) ? vendor : redactVendorFinance(vendor);
  return jsonResponse(ok({ ...safeVendor, settlements, recentOrders: orders.items }));
});

vendors.patch('/:id/status', ...adminGuard, async (c) => {
  const companyId = c.req.param('id');
  if (!isUuid(companyId)) return errorResponse('Vendor ID must be a UUID.', 400);
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const { status } = parsed.body;
  if (!vendorStatuses.has(status)) return errorResponse('status must be active, suspended, or pending_approval.', 400);
  const db = createDb(c.env);
  const user = c.get('adminUser');
  const governorates = assignedGovernorates(user);
  const rows = governorates === null
    ? await db.query('UPDATE public.companies SET status = $2, updated_at = NOW() WHERE id = $1::uuid RETURNING id, status', [companyId, status])
    : await db.query('UPDATE public.companies SET status = $2, updated_at = NOW() WHERE id = $1::uuid AND governorate = ANY($3::text[]) RETURNING id, status', [companyId, status, governorates]);
  if (!rows.length) return errorResponse('Vendor not found.', 404);
  await writeAudit(db, c, user.id, 'vendor.status.update', 'company', companyId, { status });
  return jsonResponse(ok(rows[0], 'Vendor status updated.'));
});

vendors.patch('/:id/governorate', ...superAdminGuard, async (c) => {
  const companyId = c.req.param('id');
  if (!isUuid(companyId)) return errorResponse('Vendor ID must be a UUID.', 400);
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const value = parsed.body.governorate;
  const governorate = value === null || value === '' ? null : normalizeGovernorate(value);
  if (value !== null && value !== '' && !governorate) {
    return errorResponse('اختر محافظة صحيحة من قائمة محافظات مصر.', 400);
  }
  const db = createDb(c.env);
  const [updated] = await db.query(
    `UPDATE public.companies SET governorate = $2, updated_at = NOW()
     WHERE id = $1::uuid RETURNING id, governorate`,
    [companyId, governorate],
  );
  if (!updated) return errorResponse('Vendor not found.', 404);
  await writeAudit(db, c, c.get('adminUser').id, 'vendor.governorate.update', 'company', companyId, { governorate });
  return jsonResponse(ok({ ...updated, availableGovernorates: EGYPT_GOVERNORATES }, 'تم تحديث محافظة التاجر.'));
});

vendors.patch('/:id/commission', ...superAdminGuard, async (c) => {
  const companyId = c.req.param('id');
  if (!isUuid(companyId)) return errorResponse('Vendor ID must be a UUID.', 400);
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const { type, value } = parsed.body;
  if (!['percentage', 'fixed'].includes(type) || !isMoney(value) || (type === 'percentage' && value > 100)) {
    return errorResponse('type must be percentage or fixed; value must be non-negative (percentage max 100).', 400);
  }
  const db = createDb(c.env);
  const [company] = await db`SELECT id FROM public.companies WHERE id = ${companyId} LIMIT 1`;
  if (!company) return errorResponse('Vendor not found.', 404);
  const [settings] = await db`
    INSERT INTO public.admin_company_settings (company_id, commission_type, commission_value, updated_by_admin_user_id, updated_at)
    VALUES (${companyId}, ${type}, ${value}, ${c.get('adminUser').id}, NOW())
    ON CONFLICT (company_id) DO UPDATE SET commission_type = EXCLUDED.commission_type,
      commission_value = EXCLUDED.commission_value, updated_by_admin_user_id = EXCLUDED.updated_by_admin_user_id, updated_at = NOW()
    RETURNING company_id AS "vendorId", commission_type AS "commissionType", commission_value::numeric AS "commissionValue"
  `;
  await writeAudit(db, c, c.get('adminUser').id, 'vendor.commission.update', 'company', companyId, { type, value });
  return jsonResponse(ok(settings, 'Vendor commission updated.'));
});

export default vendors;
