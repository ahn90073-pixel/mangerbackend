import test from 'node:test';
import assert from 'node:assert/strict';
import { listTenants } from '../src/lib/tenant.js';

const companies = [
  { id: '11111111-1111-4111-8111-111111111111', display_name: 'متجر القاهرة', tenant_schema_name: 'tenant_cairo', governorate: 'القاهرة' },
  { id: '22222222-2222-4222-8222-222222222222', display_name: 'متجر الجيزة', tenant_schema_name: 'tenant_giza', governorate: 'الجيزة' },
];

function createDbMock() {
  const calls = [];
  const db = async () => [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    const [companyId, governorates] = params;
    return companies.filter((company) =>
      (!companyId || company.id === companyId)
      && (!governorates || governorates.includes(company.governorate))
    );
  };
  return { db, calls };
}

test('tenant metadata and product schemas are loaded only for assigned governorates', async () => {
  const { db, calls } = createDbMock();
  const rows = await listTenants(db, null, ['القاهرة']);
  assert.deepEqual(rows.map((row) => row.id), [companies[0].id]);
  assert.match(calls[0].sql, /governorate = ANY\(\$2::text\[\]\)/);
  assert.deepEqual(calls[0].params, [null, ['القاهرة']]);
});

test('an employee with an empty governorate assignment cannot load any tenant', async () => {
  const { db } = createDbMock();
  const rows = await listTenants(db, null, []);
  assert.deepEqual(rows, []);
});
