const TENANT_SCHEMA_RE = /^tenant_[a-z0-9_]{1,54}$/;
const TENANT_TABLES = new Set(['products', 'categories', 'product_images', 'orders', 'order_items', 'customers', 'addresses', 'shipments']);
const initializedSchemas = new Map();

export function tenantTable(schemaName, tableName) {
  if (typeof schemaName !== 'string' || !TENANT_SCHEMA_RE.test(schemaName)) {
    throw new Error('Invalid tenant schema name in companies.');
  }
  if (!TENANT_TABLES.has(tableName)) throw new Error('Invalid tenant table reference.');
  return `"${schemaName}"."${tableName}"`;
}

async function ensureTenantSchema(db, tenant) {
  const schema = tenant.tenant_schema_name;
  if (initializedSchemas.has(schema)) return initializedSchemas.get(schema);
  const promise = db`SELECT public.ensure_mange_admin_product_schema(${tenant.id})`;
  initializedSchemas.set(schema, promise);
  try {
    await promise;
  } catch (error) {
    initializedSchemas.delete(schema);
    throw error;
  }
}

export async function listTenants(db, companyId = null, governorates = null) {
  const rows = await db.query(
    `SELECT id, display_name, tenant_schema_name, governorate
     FROM public.companies
     WHERE ($1::uuid IS NULL OR id = $1::uuid)
       AND ($2::text[] IS NULL OR governorate = ANY($2::text[]))
     ORDER BY created_at DESC`,
    [companyId, governorates],
  );
  for (const row of rows) {
    if (!TENANT_SCHEMA_RE.test(row.tenant_schema_name || '')) {
      throw new Error(`Company ${row.id} has no valid tenant schema.`);
    }
  }
  for (let start = 0; start < rows.length; start += 8) {
    await Promise.all(rows.slice(start, start + 8).map((tenant) => ensureTenantSchema(db, tenant)));
  }
  return rows;
}
