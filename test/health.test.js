import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/index.js';

test('health endpoint responds without requiring database credentials', async () => {
  const response = await app.request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    service: 'mange-admin-backend',
    status: 'healthy',
  });
});

test('unknown endpoint returns a consistent JSON 404', async () => {
  const response = await app.request('/unknown');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).success, false);
});
