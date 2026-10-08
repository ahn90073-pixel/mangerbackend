import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCommission, calculateSettlementCommission, roundMoney, initials } from '../src/lib/finance.js';
import { tenantTable } from '../src/lib/tenant.js';

test('percentage commission rounds currency values to two decimals', () => {
  assert.equal(calculateCommission(1000, 'percentage', 12.5), 125);
  assert.equal(calculateCommission(10.01, 'percentage', 7.5), 0.75);
});

test('fixed commission is capped at settlement gross amount', () => {
  assert.equal(calculateCommission(450, 'fixed', 20), 20);
  assert.equal(calculateCommission(10, 'fixed', 20), 10);
});

test('settlement commission does not charge the fixed fee twice', () => {
  assert.equal(calculateSettlementCommission(40, 'fixed', 20, 500, 0), 20);
  assert.equal(calculateSettlementCommission(40, 'fixed', 20, 500, 20), 0);
  assert.equal(calculateSettlementCommission(100, 'percentage', 10, 500, 0), 10);
});

test('roundMoney and initials handle numeric and Arabic names', () => {
  assert.equal(roundMoney(12.345), 12.35);
  assert.equal(initials('شركة النور'), 'شا');
  assert.equal(initials(''), '—');
});

test('tenantTable quotes valid schema names and rejects unsafe identifiers', () => {
  assert.equal(tenantTable('tenant_example_a1b2c3d4', 'products'), '"tenant_example_a1b2c3d4"."products"');
  assert.throws(() => tenantTable('tenant_x; DROP SCHEMA public', 'products'), /Invalid tenant schema/);
  assert.throws(() => tenantTable('tenant_ok', 'users'), /Invalid tenant table/);
});
