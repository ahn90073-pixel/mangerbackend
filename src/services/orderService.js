import { listTenants, tenantTable } from '../lib/tenant.js';
import { paginated } from '../lib/validation.js';

export async function listAdminOrders(db, options = {}) {
  const {
    page = 1,
    limit = 20,
    offset = (page - 1) * limit,
    q = '',
    status = '',
    companyId = null,
    governorates = null,
  } = options;
  if (governorates !== null && !governorates.length) return paginated([], 0, page, limit);
  const tenants = await listTenants(db, companyId);
  if (!tenants.length) return paginated([], 0, page, limit);

  const values = tenants.map((tenant) => tenant.id);
  let governorateFilter = '';
  if (governorates !== null) {
    values.push(governorates);
    governorateFilter = ` AND c.governorate = ANY($${values.length}::text[])`;
  }
  const branches = tenants.map((tenant, index) => {
    const p = `$${index + 1}`;
    const orders = tenantTable(tenant.tenant_schema_name, 'orders');
    const customers = tenantTable(tenant.tenant_schema_name, 'customers');
    return `SELECT o.id, o.order_number, o.company_id, c.display_name AS vendor_name,
      c.governorate AS vendor_governorate,
      COALESCE(cu.full_name, cu.email, cu.phone, 'زائر') AS customer_name,
      o.grand_total::numeric AS amount, o.currency::text AS currency, o.status,
      o.payment_status, COALESCE(o.placed_at, o.created_at) AS ordered_at
      FROM ${orders} o
      JOIN public.companies c ON c.id = o.company_id
      LEFT JOIN ${customers} cu ON cu.id = o.customer_id
      WHERE o.company_id = ${p}::uuid${governorateFilter}`;
  });

  const filters = [];
  if (status && status !== 'all') {
    values.push(status);
    filters.push(`orders.status = $${values.length}`);
  }
  if (q) {
    values.push(`%${q}%`);
    const p = `$${values.length}`;
    filters.push(`(orders.order_number ILIKE ${p} OR orders.vendor_name ILIKE ${p} OR orders.customer_name ILIKE ${p} OR orders.id::text ILIKE ${p})`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  values.push(limit, offset);
  const limitParam = `$${values.length - 1}`;
  const offsetParam = `$${values.length}`;
  const rows = await db.query(
    `SELECT orders.*, count(*) OVER()::int AS _total
     FROM (${branches.join(' UNION ALL ')}) AS orders
     ${where}
     ORDER BY orders.ordered_at DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    values,
  );
  const total = rows.length ? rows[0]._total : 0;
  const items = rows.map((row) => ({
    id: row.order_number,
    orderId: row.id,
    vendorId: row.company_id,
    vendorName: row.vendor_name,
    vendorGovernorate: row.vendor_governorate,
    customer: row.customer_name,
    amount: Number(row.amount || 0),
    currency: row.currency?.trim() || 'EGP',
    status: row.status,
    paymentStatus: row.payment_status,
    date: row.ordered_at,
  }));
  return paginated(items, total, page, limit);
}
