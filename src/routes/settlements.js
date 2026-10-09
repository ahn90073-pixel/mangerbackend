import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { calculateSettlementCommission, roundMoney } from '../lib/finance.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { superAdminGuard } from '../middleware/adminAuth.js';
import { isMoney, isText, isUuid, pagination, paginated, readJson, searchTerm } from '../lib/validation.js';
import { writeAudit } from '../lib/audit.js';
import { getVendorSummaries } from '../services/vendorService.js';

const settlements = new Hono();
const statuses = new Set(['pending', 'completed', 'void']);

settlements.get('/', ...superAdminGuard, async (c) => {
  const { page, limit, offset } = pagination(c, 20, 100);
  const status = c.req.query('status') || 'all';
  if (status !== 'all' && !statuses.has(status)) return errorResponse('Unsupported settlement status.', 400);
  const vendorId = c.req.query('vendorId') || '';
  if (vendorId && !isUuid(vendorId)) return errorResponse('vendorId must be a UUID.', 400);
  const q = searchTerm(c.req.query('q'));
  const values = [];
  const filters = [];
  if (status !== 'all') { values.push(status); filters.push(`s.status = $${values.length}`); }
  else filters.push("s.status <> 'void'");
  if (vendorId) { values.push(vendorId); filters.push(`s.company_id = $${values.length}::uuid`); }
  if (q) {
    values.push(`%${q}%`);
    const p = `$${values.length}`;
    filters.push(`(c.display_name ILIKE ${p} OR s.reference ILIKE ${p} OR s.id::text ILIKE ${p})`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  values.push(limit, offset);
  const rows = await createDb(c.env).query(
    `SELECT s.id, s.company_id AS vendor_id, c.display_name AS vendor_name,
      s.amount::numeric AS amount, s.commission_amount::numeric AS commission_deducted,
      s.net_amount::numeric AS net_amount, s.currency, s.period, s.paid_at,
      s.status, s.method, s.reference, s.created_at, count(*) OVER()::int AS _total
     FROM public.admin_settlements s JOIN public.companies c ON c.id = s.company_id
     ${where} ORDER BY s.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = rows.length ? rows[0]._total : 0;
  const items = rows.map((row) => ({
    id: row.id,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    amount: Number(row.amount),
    commissionDeducted: Number(row.commission_deducted),
    netAmount: Number(row.net_amount),
    currency: row.currency?.trim() || c.env.DEFAULT_CURRENCY || 'EGP',
    period: row.period,
    date: row.paid_at || row.created_at,
    status: row.status,
    method: row.method,
    reference: row.reference,
  }));
  return jsonResponse(ok(paginated(items, total, page, limit)));
});

settlements.post('/', ...superAdminGuard, async (c) => {
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const { vendorId, amount, period, method, currency } = parsed.body;
  if (!isUuid(vendorId) || !isMoney(amount) || amount <= 0 || !isText(period, 100) || !isText(method, 80)) {
    return errorResponse('vendorId, a positive amount, period, and payment method are required.', 400);
  }
  const currencyCode = currency === undefined ? (c.env.DEFAULT_CURRENCY || 'EGP') : currency;
  if (typeof currencyCode !== 'string' || !/^[A-Z]{3}$/.test(currencyCode)) return errorResponse('currency must be a 3-letter uppercase code.', 400);

  const db = createDb(c.env);
  const [vendor] = await db`
    SELECT c.id, c.status, COALESCE(s.commission_type, 'percentage') AS commission_type,
      COALESCE(s.commission_value, 0)::numeric AS commission_value
    FROM public.companies c LEFT JOIN public.admin_company_settings s ON s.company_id = c.id
    WHERE c.id = ${vendorId} LIMIT 1
  `;
  if (!vendor) return errorResponse('Vendor not found.', 404);
  if (vendor.status !== 'active') return errorResponse('Settlements can only be recorded for active vendors.', 409);

  const grossAmount = roundMoney(amount);
  const [summary] = await getVendorSummaries(db, vendorId);
  if (!summary) return errorResponse('Vendor financial summary is unavailable.', 409);
  const [prior] = await db`SELECT COALESCE(SUM(commission_amount), 0)::numeric AS already_deducted
    FROM public.admin_settlements WHERE company_id = ${vendorId} AND status = 'completed'`;
  const commissionAmount = calculateSettlementCommission(
    grossAmount,
    vendor.commission_type,
    Number(vendor.commission_value),
    summary.totalSales,
    Number(prior?.already_deducted || 0),
  );
  const netAmount = roundMoney(grossAmount - commissionAmount);
  if (netAmount <= 0) return errorResponse('The net payout must be greater than zero.', 409);
  if (netAmount > summary.netBalance + 0.01) {
    return errorResponse(`Payout exceeds the vendor's available balance (${summary.netBalance.toFixed(2)}).`, 409);
  }
  const reference = `MNG-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const actorId = c.get('adminUser').id;
  const [settlement] = await db`
    INSERT INTO public.admin_settlements
      (company_id, amount, commission_amount, net_amount, currency, period, paid_at, status, method, reference, created_by_admin_user_id)
    VALUES
      (${vendorId}, ${grossAmount}, ${commissionAmount}, ${netAmount}, ${currencyCode}, ${period.trim()}, NOW(), 'completed', ${method.trim()}, ${reference}, ${actorId})
    RETURNING id, company_id AS "vendorId", amount::numeric AS amount,
      commission_amount::numeric AS "commissionDeducted", net_amount::numeric AS "netAmount",
      currency, period, paid_at AS date, status, method, reference
  `;
  await writeAudit(db, c, actorId, 'settlement.create', 'settlement', settlement.id, {
    vendorId, amount: grossAmount, commissionAmount, netAmount, currency: currencyCode,
  });
  return jsonResponse(ok(settlement, 'Settlement voucher recorded.'), 201);
});

settlements.patch('/:id/status', ...superAdminGuard, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return errorResponse('Settlement ID must be a UUID.', 400);
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const { status } = parsed.body;
  if (!['completed', 'void'].includes(status)) return errorResponse('status must be completed or void.', 400);
  const db = createDb(c.env);
  const [current] = await db`SELECT id, status FROM public.admin_settlements WHERE id = ${id} LIMIT 1`;
  if (!current) return errorResponse('Settlement not found.', 404);
  if (current.status === 'void') return errorResponse('A void settlement cannot be changed.', 409);
  const [updated] = await db`
    UPDATE public.admin_settlements SET status = ${status},
      paid_at = CASE WHEN ${status} = 'completed' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, company_id AS "vendorId", status, paid_at AS date, reference
  `;
  await writeAudit(db, c, c.get('adminUser').id, `settlement.${status}`, 'settlement', id, { previousStatus: current.status });
  return jsonResponse(ok(updated, 'Settlement status updated.'));
});

export default settlements;
