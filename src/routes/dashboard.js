import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { tenantTable, listTenants } from '../lib/tenant.js';
import { jsonResponse, ok } from '../lib/response.js';
import { superAdminGuard } from '../middleware/adminAuth.js';
import { assignedGovernorates } from '../lib/access.js';
import { getVendorSummaries } from '../services/vendorService.js';
import { listAdminOrders } from '../services/orderService.js';

const dashboard = new Hono();

async function getProductCounts(db, companyIds = null, governorates = null) {
  const allTenants = await listTenants(db, null, governorates);
  const selected = companyIds === null
    ? allTenants
    : allTenants.filter((tenant) => companyIds.has(tenant.id));
  if (!selected.length) return { pending: 0, active: 0, rejected: 0 };
  const branches = selected.map((tenant) => {
    const table = tenantTable(tenant.tenant_schema_name, 'products');
    return `SELECT
      (SELECT COUNT(*) FROM ${table} WHERE status = 'pending')::int AS pending,
      (SELECT COUNT(*) FROM ${table} WHERE status = 'active')::int AS active,
      (SELECT COUNT(*) FROM ${table} WHERE status = 'rejected')::int AS rejected`;
  });
  const rows = await db.query(branches.join(' UNION ALL '), []);
  return rows.reduce((acc, row) => ({
    pending: acc.pending + Number(row.pending || 0),
    active: acc.active + Number(row.active || 0),
    rejected: acc.rejected + Number(row.rejected || 0),
  }), { pending: 0, active: 0, rejected: 0 });
}

dashboard.get('/', ...superAdminGuard, async (c) => {
  const db = createDb(c.env);
  const user = c.get('adminUser');
  const governorates = assignedGovernorates(user);
  const vendors = await getVendorSummaries(db, null, governorates);
  const [products, settlements, recentOrders] = await Promise.all([
    getProductCounts(db, new Set(vendors.map((vendor) => vendor.id)), governorates),
    db.query(`SELECT COUNT(*) FILTER (WHERE s.status = 'completed')::int AS completed_count,
        COUNT(*) FILTER (WHERE s.status = 'pending')::int AS pending_count,
        COALESCE(SUM(s.net_amount) FILTER (WHERE s.status = 'completed'), 0)::numeric AS total_net,
        COALESCE(SUM(s.commission_amount) FILTER (WHERE s.status = 'completed'), 0)::numeric AS total_commission
      FROM public.admin_settlements s JOIN public.companies c ON c.id = s.company_id
      WHERE ($1::text[] IS NULL OR c.governorate = ANY($1::text[]))`, [governorates]),
    listAdminOrders(db, { page: 1, limit: 5, offset: 0, governorates }),
  ]);
  const settlement = settlements[0] || {};
  const totalSales = vendors.reduce((sum, vendor) => sum + vendor.totalSales, 0);
  const totalCommission = vendors.reduce((sum, vendor) => sum + vendor.commissionAmount, 0);
  const activeVendors = vendors.filter((vendor) => vendor.status === 'active').length;
  const data = {
    currency: c.env.DEFAULT_CURRENCY || 'EGP',
    role: user.role,
    assignedGovernorates: user.assignedGovernorates,
    metrics: {
      totalSales,
      totalCommission,
      totalVendors: vendors.length,
      activeVendors,
      pendingProducts: products.pending,
      activeProducts: products.active,
      rejectedProducts: products.rejected,
      totalOrders: vendors.reduce((sum, vendor) => sum + vendor.totalOrders, 0),
      completedSettlements: Number(settlement.completed_count || 0),
      pendingSettlements: Number(settlement.pending_count || 0),
      totalSettled: Number(settlement.total_net || 0),
      settledCommission: Number(settlement.total_commission || 0),
    },
    topVendors: [...vendors]
      .sort((a, b) => b.totalSales - a.totalSales)
      .slice(0, 4),
    recentOrders: recentOrders.items,
  };
  return jsonResponse(ok(data));
});

export default dashboard;
