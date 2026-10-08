import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { tenantTable, listTenants } from '../lib/tenant.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { adminGuard } from '../middleware/adminAuth.js';
import { pagination, paginated, readJson, searchTerm, isUuid, isText } from '../lib/validation.js';
import { writeAudit } from '../lib/audit.js';

const products = new Hono();

async function getProductPage(db, c, forceStatus = null, view = 'review') {
  const { page, limit, offset } = pagination(c, 24, 100);
  const requestedStatus = forceStatus || c.req.query('status') || 'pending';
  const search = searchTerm(c.req.query('q'));
  const companyId = c.req.query('vendorId') || '';
  if (companyId && !isUuid(companyId)) return { error: errorResponse('vendorId must be a valid UUID.', 400) };
  const daysValue = c.req.query('olderThanDays');
  const olderThanDays = daysValue === undefined ? null : Number.parseInt(daysValue, 10);
  if (olderThanDays !== null && (!Number.isInteger(olderThanDays) || olderThanDays < 0 || olderThanDays > 3650)) {
    return { error: errorResponse('olderThanDays must be an integer from 0 to 3650.', 400) };
  }

  let tenants = await listTenants(db, companyId || null);
  if (companyId && !tenants.length) return { data: paginated([], 0, page, limit) };
  if (!tenants.length) return { data: paginated([], 0, page, limit) };

  const branches = tenants.map((tenant) => {
    const productTable = tenantTable(tenant.tenant_schema_name, 'products');
    const categoryTable = tenantTable(tenant.tenant_schema_name, 'categories');
    const orderItems = tenantTable(tenant.tenant_schema_name, 'order_items');
    const orderTable = tenantTable(tenant.tenant_schema_name, 'orders');
    return `SELECT p.id, p.company_id, p.name, p.description, p.price::numeric AS price,
      p.status, p.created_at AS submitted_at, p.published_at, p.rejection_reason,
      p.admin_kept AS kept, COALESCE(cat.name, '—') AS category,
      (SELECT COALESCE(SUM(oi.quantity), 0)::int FROM ${orderItems} oi
        JOIN ${orderTable} ord ON ord.id = oi.order_id
        WHERE oi.product_id = p.id AND ord.status NOT IN ('cancelled','refunded')) AS sales_count
      FROM ${productTable} p
      LEFT JOIN ${categoryTable} cat ON cat.id = p.category_id`;
  });

  const values = [];
  const filters = [];
  if (requestedStatus === 'pending') filters.push("p.status = 'pending'");
  else if (requestedStatus === 'approved') filters.push("p.status = 'active'");
  else if (requestedStatus === 'rejected') filters.push("p.status = 'rejected'");
  else if (requestedStatus === 'active') filters.push("p.status = 'active'");
  else if (requestedStatus === 'all') filters.push("p.status IN ('pending','active','rejected')");
  else return { error: errorResponse('status must be pending, approved, rejected, active, or all.', 400) };

  if (companyId) {
    values.push(companyId);
    filters.push(`p.company_id = $${values.length}::uuid`);
  }
  if (search) {
    values.push(`%${search}%`);
    const p = `$${values.length}`;
    filters.push(`(p.name ILIKE ${p} OR co.display_name ILIKE ${p} OR p.id::text ILIKE ${p})`);
  }
  if (olderThanDays !== null) {
    values.push(olderThanDays);
    filters.push(`p.published_at < NOW() - ($${values.length}::int * INTERVAL '1 day')`);
  }
  const order = view === 'active' ? 'COALESCE(p.published_at, p.submitted_at) ASC' : 'p.submitted_at DESC';
  values.push(limit, offset);
  const limitParam = `$${values.length - 1}`;
  const offsetParam = `$${values.length}`;
  const rows = await db.query(
    `SELECT p.*, co.display_name AS vendor_name, count(*) OVER()::int AS _total
     FROM (${branches.join(' UNION ALL ')}) p
     JOIN public.companies co ON co.id = p.company_id
     WHERE ${filters.join(' AND ')}
     ORDER BY ${order}
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    values,
  );
  const total = rows.length ? rows[0]._total : 0;
  const items = rows.map((row) => ({
    id: row.id,
    vendorId: row.company_id,
    vendorName: row.vendor_name,
    name: row.name,
    description: row.description || '',
    category: row.category,
    price: Number(row.price || 0),
    status: row.status === 'active' && view !== 'active' ? 'approved' : row.status,
    submittedAt: row.submitted_at,
    publishedAt: row.published_at,
    rejectReason: row.rejection_reason,
    kept: Boolean(row.kept),
    salesCount: Number(row.sales_count || 0),
  }));
  return { data: paginated(items, total, page, limit) };
}

products.get('/', ...adminGuard, async (c) => {
  const result = await getProductPage(createDb(c.env), c);
  if (result.error) return result.error;
  return jsonResponse(ok(result.data));
});

products.get('/active', ...adminGuard, async (c) => {
  const result = await getProductPage(createDb(c.env), c, 'active', 'active');
  if (result.error) return result.error;
  return jsonResponse(ok(result.data));
});

products.patch('/:companyId/:productId/review', ...adminGuard, async (c) => {
  const companyId = c.req.param('companyId');
  const productId = c.req.param('productId');
  if (!isUuid(companyId) || !isUuid(productId)) return errorResponse('Company and product IDs must be UUIDs.', 400);
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const { decision, reason } = parsed.body;
  if (!['approve', 'reject'].includes(decision)) return errorResponse('decision must be approve or reject.', 400);
  if (decision === 'reject' && !isText(reason, 2000)) return errorResponse('A rejection reason of at most 2000 characters is required.', 400);

  const db = createDb(c.env);
  const [tenant] = await listTenants(db, companyId);
  if (!tenant) return errorResponse('Vendor not found.', 404);
  const table = tenantTable(tenant.tenant_schema_name, 'products');
  const reviewer = c.get('adminUser').id;
  const rows = decision === 'approve'
    ? await db.query(`UPDATE ${table} SET status = 'active', reviewed_at = NOW(), reviewed_by = $1,
        rejection_reason = NULL, published_at = COALESCE(published_at, NOW()), updated_at = NOW()
        WHERE id = $2 AND company_id = $3 AND status = 'pending' RETURNING id, company_id, name, status, reviewed_at`, [reviewer, productId, companyId])
    : await db.query(`UPDATE ${table} SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $1,
        rejection_reason = $2, updated_at = NOW()
        WHERE id = $3 AND company_id = $4 AND status = 'pending' RETURNING id, company_id, name, status, rejection_reason, reviewed_at`, [reviewer, reason.trim(), productId, companyId]);
  if (!rows.length) return errorResponse('Pending product not found or already reviewed.', 409);
  await writeAudit(db, c, reviewer, `product.${decision}`, 'product', productId, { companyId, reason: decision === 'reject' ? reason.trim() : null });
  return jsonResponse(ok(rows[0], decision === 'approve' ? 'Product approved and published.' : 'Product rejected.'));
});

products.patch('/:companyId/:productId/keep', ...adminGuard, async (c) => {
  const companyId = c.req.param('companyId');
  const productId = c.req.param('productId');
  if (!isUuid(companyId) || !isUuid(productId)) return errorResponse('Company and product IDs must be UUIDs.', 400);
  const db = createDb(c.env);
  const [tenant] = await listTenants(db, companyId);
  if (!tenant) return errorResponse('Vendor not found.', 404);
  const table = tenantTable(tenant.tenant_schema_name, 'products');
  const [product] = await db.query(`UPDATE ${table} SET admin_kept = TRUE, updated_at = NOW()
    WHERE id = $1 AND company_id = $2 AND status = 'active' RETURNING id, company_id, admin_kept`, [productId, companyId]);
  if (!product) return errorResponse('Active product not found.', 404);
  await writeAudit(db, c, c.get('adminUser').id, 'product.keep', 'product', productId, { companyId });
  return jsonResponse(ok(product, 'Product marked to remain listed.'));
});

products.delete('/:companyId/:productId', ...adminGuard, async (c) => {
  const companyId = c.req.param('companyId');
  const productId = c.req.param('productId');
  if (!isUuid(companyId) || !isUuid(productId)) return errorResponse('Company and product IDs must be UUIDs.', 400);
  const db = createDb(c.env);
  const [tenant] = await listTenants(db, companyId);
  if (!tenant) return errorResponse('Vendor not found.', 404);
  const table = tenantTable(tenant.tenant_schema_name, 'products');
  const [product] = await db.query(`UPDATE ${table} SET status = 'archived', admin_archived_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND company_id = $2 AND status = 'active' RETURNING id, company_id, status`, [productId, companyId]);
  if (!product) return errorResponse('Active product not found.', 404);
  await writeAudit(db, c, c.get('adminUser').id, 'product.archive', 'product', productId, { companyId });
  return jsonResponse(ok(product, 'Product removed from listing.'));
});

export default products;
