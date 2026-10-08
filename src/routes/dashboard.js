import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { tenantTable, listTenants } from '../lib/tenant.js';
import { jsonResponse, ok } from '../lib/response.js';
import { adminGuard } from '../middleware/adminAuth.js';
import { getVendorSummaries } from '../services/vendorService.js';
import { listAdminOrders } from '../services/orderService.js';

const dashboard = new Hono();

async function getProductCounts(db) {
  const tenants = await listTenants(db);
  if (!tenants.length) return { pending: 0, active: 0, rejected: 0 };
  const branches = tenants.map((tenant) => {
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

dashboard.get('/', ...adminGuard, async (c) => {
  const db = createDb(c.env);
  const [vendors, products, settlements, recentOrders] = await Promise.all([
    getVendorSummaries(db),
    getProductCounts(db),
    db`SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
        COALESCE(SUM(net_amount) FILTER (WHERE status = 'completed'), 0)::numeric AS total_net,
        COALESCE(SUM(commission_amount) FILTER (WHERE status = 'completed'), 0)::numeric AS total_commission
      FROM public.admin_settlements`,
    listAdminOrders(db, { page: 1, limit: 5, offset: 0 }),
  ]);
  const settlement = settlements[0] || {};
  const totalSales = vendors.reduce((sum, vendor) => sum + vendor.totalSales, 0);
  const totalCommission = vendors.reduce((sum, vendor) => sum + vendor.commissionAmount, 0);
  const activeVendors = vendors.filter((vendor) => vendor.status === 'active').length;
  const data = {
    currency: c.env.DEFAULT_CURRENCY || 'EGP',
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
    topVendors: [...vendors].sort((a, b) => b.totalSales - a.totalSales).slice(0, 4),
    recentOrders: recentOrders.items,
  };
  return jsonResponse(ok(data));
});

export default dashboard;
