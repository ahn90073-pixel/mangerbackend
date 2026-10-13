import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminToken, verifyAdminToken } from '../src/lib/adminToken.js';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { EGYPT_GOVERNORATES, normalizeGovernorateList } from '../src/lib/governorates.js';
import { assignedGovernorates, isSuperAdmin } from '../src/lib/access.js';
import { requireSuperAdmin } from '../src/middleware/adminAuth.js';

const secret = 'test-only-secret-that-is-long-enough-for-hmac';

test('admin JWT is signed, expires, and is rejected after tampering', async () => {
  const now = 1_800_000_000;
  const token = await createAdminToken({ id: '11111111-1111-4111-8111-111111111111', token_version: 3 }, secret, now);
  const claims = await verifyAdminToken(token, secret, now + 1);
  assert.equal(claims.sub, '11111111-1111-4111-8111-111111111111');
  assert.equal(claims.ver, 3);
  assert.equal(await verifyAdminToken(token, 'a-different-test-secret-that-is-long-enough', now + 1), null);
  assert.equal(await verifyAdminToken(`${token.slice(0, -1)}x`, secret, now + 1), null);
  assert.equal(await verifyAdminToken(token, secret, now + (8 * 60 * 60)), null);
});

test('employee password hashing and verification use parameterized Neon pgcrypto calls', async () => {
  const correctPassword = 'a-secure-password-with-12';
  const storedHash = '$6$rounds=500000$synthetic-salt$synthetic-hash';
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('gen_salt')) return [{ password_hash: storedHash }];
      return [{ valid: params[0] === correctPassword && params[1] === storedHash }];
    },
  };

  assert.equal(await hashPassword(db, correctPassword), storedHash);
  assert.equal(await verifyPassword(db, correctPassword, storedHash), true);
  assert.equal(await verifyPassword(db, 'incorrect-password', storedHash), false);
  assert.equal(await verifyPassword(db, correctPassword, '$2a$12$unsupported-format'), false);
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /crypt\(\$1::text, gen_salt\('sha512crypt', 500000\)\)/);
  assert.match(calls[1].sql, /crypt\(\$1::text, \$2::text\)/);
  assert.equal(calls[0].sql.includes(correctPassword), false);
  assert.deepEqual(calls[0].params, [correctPassword]);
});

test('governorates are allow-listed and de-duplicated', () => {
  assert.equal(EGYPT_GOVERNORATES.length, 27);
  assert.deepEqual(normalizeGovernorateList(['القاهرة', 'القاهرة', 'الجيزة']), ['القاهرة', 'الجيزة']);
  assert.equal(normalizeGovernorateList(['القاهرة', 'مكة']), null);
});

test('only super admins receive unrestricted governorate scope', () => {
  const admin = { role: 'super_admin', assignedGovernorates: [] };
  const employee = { role: 'employee', assignedGovernorates: ['القاهرة'] };
  assert.equal(isSuperAdmin(admin), true);
  assert.equal(assignedGovernorates(admin), null);
  assert.deepEqual(assignedGovernorates(employee), ['القاهرة']);
});

test('employees are denied super-admin-only routes while super admins pass', async () => {
  let employeeNextCalled = false;
  const denied = await requireSuperAdmin({ get: () => ({ role: 'employee' }) }, async () => { employeeNextCalled = true; });
  assert.equal(denied.status, 403);
  assert.equal(employeeNextCalled, false);

  let adminNextCalled = false;
  const allowed = await requireSuperAdmin({ get: () => ({ role: 'super_admin' }) }, async () => { adminNextCalled = true; });
  assert.equal(allowed, undefined);
  assert.equal(adminNextCalled, true);
});
