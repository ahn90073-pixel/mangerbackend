import { tenantTable, listTenants } from '../lib/tenant.js';
import { calculateCommission, initials, roundMoney } from '../lib/finance.js';

async function loadCompanyRows(db, companyId = null) {
  return companyId
    ? await db`
        SELECT c.id, c.slug, c.tenant_schema_name, c.legal_name, c.display_name, c.email, c.status, c.created_at,
          owner.full_name AS merchant_name,
          COALESCE(c.email, owner.email) AS contact_email,
          owner.phone AS contact_phone,
          COALESCE(settings.commission_type, 'percentage') AS commission_type,
          COALESCE(settings.commission_value, 0)::numeric AS commission_value,
          COALESCE(settled.net_amount, 0)::numeric AS settled_amount
        FROM public.companies c
        LEFT JOIN LATERAL (
          SELECT u.full_name, u.email, u.phone
          FROM public.company_members cm JOIN public.users u ON u.id = cm.user_id
          WHERE cm.company_id = c.id AND cm.is_active = TRUE
          ORDER BY (cm.role = 'owner') DESC, cm.created_at ASC LIMIT 1
        ) owner ON TRUE
        LEFT JOIN public.admin_company_settings settings ON settings.company_id = c.id
        LEFT JOIN LATERAL (
          SELECT SUM(s.net_amount) AS net_amount FROM public.admin_settlements s
          WHERE s.company_id = c.id AND s.status = 'completed'
        ) settled ON TRUE
        WHERE c.id = ${companyId}
      `
    : await db`
        SELECT c.id, c.slug, c.tenant_schema_name, c.legal_name, c.display_name, c.email, c.status, c.created_at,
          owner.full_name AS merchant_name,
          COALESCE(c.email, owner.email) AS contact_email,
          owner.phone AS contact_phone,
          COALESCE(settings.commission_type, 'percentage') AS commission_type,
          COALESCE(settings.commission_value, 0)::numeric AS commission_value,
          COALESCE(settled.net_amount, 0)::numeric AS settled_amount
        FROM public.companies c
        LEFT JOIN LATERAL (
          SELECT u.full_name, u.email, u.phone
          FROM public.company_members cm JOIN public.users u ON u.id = cm.user_id
          WHERE cm.company_id = c.id AND cm.is_active = TRUE
          ORDER BY (cm.role = 'owner') DESC, cm.created_at ASC LIMIT 1
        ) owner ON TRUE
        LEFT JOIN public.admin_company_settings settings ON settings.company_id = c.id
        LEFT JOIN LATERAL (
          SELECT SUM(s.net_amount) AS net_amount FROM public.admin_settlements s
          WHERE s.company_id = c.id AND s.status = 'completed'
        ) settled ON TRUE
        ORDER BY c.created_at DESC
      `;
}

async function loadMetrics(db, rows) {
  if (!rows.length) return new Map();
  const branches = rows.map((company, index) => {
    const p = `$${index + 1}`;
    const orders = tenantTable(company.tenant_schema_name, 'orders');
    const products = tenantTable(company.tenant_schema_name, 'products');
    return `SELECT ${p}::uuid AS company_id,
      (SELECT COALESCE(SUM(grand_total), 0) FROM ${orders} WHERE company_id = ${p}::uuid AND status NOT IN ('cancelled','refunded'))::numeric AS total_sales,
      (SELECT COUNT(*) FROM ${orders} WHERE company_id = ${p}::uuid AND status NOT IN ('cancelled','refunded'))::int AS total_orders,
      (SELECT COUNT(*) FROM ${products} WHERE company_id = ${p}::uuid AND status = 'active')::int AS total_products,
      (SELECT COUNT(*) FROM ${products} WHERE company_id = ${p}::uuid AND status = 'pending')::int AS pending_products`;
  });
  const metrics = await db.query(branches.join(' UNION ALL '), rows.map((row) => row.id));
  return new Map(metrics.map((metric) => [metric.company_id, metric]));
}

export async function getVendorSummaries(db, companyId = null) {
  const rows = await loadCompanyRows(db, companyId);
  if (!rows.length) return [];
  // Apply the idempotent tenant-product metadata hook for newly created companies.
  const tenantRows = await listTenants(db, companyId);
  const schemaById = new Map(tenantRows.map((tenant) => [tenant.id, tenant.tenant_schema_name]));
  const metrics = await loadMetrics(db, rows.map((row) => ({ ...row, tenant_schema_name: schemaById.get(row.id) })));

  return rows.map((row) => {
    const metric = metrics.get(row.id) || {};
    const totalSales = Number(metric.total_sales || 0);
    const totalOrders = Number(metric.total_orders || 0);
    const commissionType = row.commission_type === 'fixed' ? 'fixed' : 'percentage';
    const commissionValue = Number(row.commission_value || 0);
    const commissionAmount = calculateCommission(totalSales, commissionType, commissionValue);
    const settledAmount = Number(row.settled_amount || 0);
    return {
      id: row.id,
      companyName: row.display_name,
      legalName: row.legal_name,
      merchantName: row.merchant_name || '—',
      email: row.contact_email || '',
      phone: row.contact_phone || '',
      city: null,
      status: row.status || 'active',
      logo: initials(row.display_name),
      totalSales: roundMoney(totalSales),
      totalOrders,
      commissionType,
      commissionValue,
      commissionAmount,
      settledAmount: roundMoney(settledAmount),
      netBalance: roundMoney(totalSales - commissionAmount - settledAmount),
      totalProducts: Number(metric.total_products || 0),
      pendingProducts: Number(metric.pending_products || 0),
      registeredAt: row.created_at,
      slug: row.slug,
    };
  });
}
