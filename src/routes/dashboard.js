import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { tenantTable, listTenants } from '../lib/tenant.js';
import { jsonResponse, ok } from '../lib/response.js';
import { adminGuard } from '../middleware/adminAuth.js';
import { isSuperAdmin, assignedGovernorates } from '../lib/access.js';
import { getVendorSummaries, redactVendorFinance } from '../services/vendorService.js';
import { listAdminOrders } from '../services/orderService.js';

const dashboard = new Hono();

async function getProductCounts(db, companyIds = null) {
  const allTenants = await listTenants(db);
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

dashboard.get('/', ...adminGuard, async (c) => {
  const db = createDb(c.env);
  const user = c.get('adminUser');
  const superAdmin = isSuperAdmin(user);
  const governorates = assignedGovernorates(user);
  const vendors = await getVendorSummaries(db, null, governorates);
  const [products, settlements, recentOrders] = await Promise.all([
    superAdmin ? getProductCounts(db) : Promise.resolve({ pending: 0, active: 0, rejected: 0 }),
    superAdmin
      ? db`SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
          COALESCE(SUM(net_amount) FILTER (WHERE status = 'completed'), 0)::numeric AS total_net,
          COALESCE(SUM(commission_amount) FILTER (WHERE status = 'completed'), 0)::numeric AS total_commission
        FROM public.admin_settlements`
      : Promise.resolve([]),
    listAdminOrders(db, { page: 1, limit: 5, offset: 0, governorates }),
  ]);
  const settlement = settlements[0] || {};
  const totalSales = superAdmin ? vendors.reduce((sum, vendor) => sum + vendor.totalSales, 0) : 0;
  const totalCommission = superAdmin ? vendors.reduce((sum, vendor) => sum + vendor.commissionAmount, 0) : 0;
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
      pendingProducts: superAdmin ? products.pending : 0,
      activeProducts: superAdmin ? products.active : 0,
      rejectedProducts: superAdmin ? products.rejected : 0,
      totalOrders: vendors.reduce((sum, vendor) => sum + vendor.totalOrders, 0),
      completedSettlements: superAdmin ? Number(settlement.completed_count || 0) : 0,
      pendingSettlements: superAdmin ? Number(settlement.pending_count || 0) : 0,
      totalSettled: superAdmin ? Number(settlement.total_net || 0) : 0,
      settledCommission: superAdmin ? Number(settlement.total_commission || 0) : 0,
    },
    topVendors: [...vendors]
      .sort((a, b) => superAdmin ? b.totalSales - a.totalSales : b.totalOrders - a.totalOrders)
      .slice(0, 4)
      .map((vendor) => superAdmin ? vendor : redactVendorFinance(vendor)),
    recentOrders: recentOrders.items,
  };
  return jsonResponse(ok(data));
});

export default dashboard;
