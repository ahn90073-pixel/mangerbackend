import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/index.js';

const companyId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const endpoint = `/api/admin/products/${companyId}/${productId}`;

test('product data cannot be edited without an authenticated super-admin session', async () => {
  const response = await app.request(endpoint, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Changed' }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).success, false);
});
