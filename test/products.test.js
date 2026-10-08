import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/index.js';

const companyId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const endpoint = `/api/admin/products/${companyId}/${productId}`;

async function patchProduct(body) {
  return app.request(endpoint, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('product edit rejects an empty payload', async () => {
  const response = await patchProduct({});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).success, false);
});

test('product edit rejects unknown fields instead of accepting status changes', async () => {
  const response = await patchProduct({ status: 'active' });
  assert.equal(response.status, 400);
});

test('product edit rejects invalid image URLs', async () => {
  const response = await patchProduct({ imageUrl: 'javascript:alert(1)' });
  assert.equal(response.status, 400);
});

test('product edit rejects a blank required product name', async () => {
  const response = await patchProduct({ name: '   ' });
  assert.equal(response.status, 400);
});
