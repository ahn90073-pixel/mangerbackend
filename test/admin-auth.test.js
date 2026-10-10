import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminToken, verifyAdminToken } from '../src/lib/adminToken.js';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { EGYPT_GOVERNORATES, normalizeGovernorateList } from '../src/lib/governorates.js';
import { assignedGovernorates, isSuperAdmin } from '../src/lib/access.js';

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

test('password hashes are salted and verification rejects wrong passwords', async () => {
  const first = await hashPassword('a-secure-password-with-12');
  const second = await hashPassword('a-secure-password-with-12');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('a-secure-password-with-12', first), true);
  assert.equal(await verifyPassword('incorrect-password', first), false);
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
