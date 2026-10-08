import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { adminGuard } from '../middleware/adminAuth.js';
import { getVendorSummaries } from '../services/vendorService.js';
import { listAdminOrders } from '../services/orderService.js';
import { pagination, paginated, readJson, searchTerm, isUuid, isMoney } from '../lib/validation.js';
import { writeAudit } from '../lib/audit.js';

const vendors = new Hono();
const vendorStatuses = new Set(['active', 'suspended', 'pending_approval']);

vendors.get('/', ...adminGuard, async (c) => {
  const db = createDb(c.env);
  const all = await getVendorSummaries(db);
  const q = searchTerm(c.req.query('q')).toLocaleLowerCase();
  const status = c.req.query('status') || 'all';
  if (status !== 'all' && !vendorStatuses.has(status)) return errorResponse('Unsupported vendor status.', 400);
  const filtered = all.filter((vendor) => {
    const matchesQuery = !q || [vendor.companyName, vendor.merchantName, vendor.id].some((value) => String(value || '').toLocaleLowerCase().includes(q));
    return matchesQuery && (status === 'all' || vendor.status === status);
  });
  const { page, limit, offset } = pagination(c, 20, 100);
  return jsonResponse(ok(paginated(filtered.slice(offset, offset + limit), filtered.length, page, limit)));
});

vendors.get('/:id', ...adminGuard, async (c) => {
  const companyId = c.req.param('id');
  if (!isUuid(companyId)) return errorResponse('Vendor ID must be a UUID.', 400);
  const db = createDb(c.env);
  const [vendor] = await getVendorSummaries(db, companyId);
  if (!vendor) return errorResponse('Vendor not found.', 404);
  const settlements = await db`
    SELECT id, company_id AS "vendorId", amount::numeric AS amount,
      commission_amount::numeric AS "commissionDeducted", net_amount::numeric AS "netAmount",
      currency, period, paid_at AS date, status, method, reference
    FROM public.admin_settlements WHERE company_id = ${companyId}
    ORDER BY created_at DESC LIMIT 50
  `;
  const orders = await listAdminOrders(db, { companyId, page: 1, limit: 10, offset: 0 });
  return jsonResponse(ok({ ...vendor, settlements, recentOrders: orders.items }));
});

vendors.patch('/:id/status', ...adminGuard, async (c) => {
  const companyId = c.req.param('id');
  if (!isUuid(companyId)) return errorResponse('Vendor ID must be a UUID.', 400);
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const { status } = parsed.body;
  if (!vendorStatuses.has(status)) return errorResponse('status must be active, suspended, or pending_approval.', 400);
  const db = createDb(c.env);
  const rows = await db`UPDATE public.companies SET status = ${status}, updated_at = NOW()
    WHERE id = ${companyId} RETURNING id, status`;
  if (!rows.length) return errorResponse('Vendor not found.', 404);
  await writeAudit(db, c, c.get('adminUser').id, 'vendor.status.update', 'company', companyId, { status });
  return jsonResponse(ok(rows[0], 'Vendor status updated.'));
});

vendors.patch('/:id/commission', ...adminGuard, async (c) => {
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
    INSERT INTO public.admin_company_settings (company_id, commission_type, commission_value, updated_by, updated_at)
    VALUES (${companyId}, ${type}, ${value}, ${c.get('adminUser').id}, NOW())
    ON CONFLICT (company_id) DO UPDATE SET commission_type = EXCLUDED.commission_type,
      commission_value = EXCLUDED.commission_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    RETURNING company_id AS "vendorId", commission_type AS "commissionType", commission_value::numeric AS "commissionValue"
  `;
  await writeAudit(db, c, c.get('adminUser').id, 'vendor.commission.update', 'company', companyId, { type, value });
  return jsonResponse(ok(settings, 'Vendor commission updated.'));
});

export default vendors;
