import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import app from '../src/index.js';
import { adminGuard } from '../src/middleware/adminAuth.js';

test('admin middleware rejects requests without a bearer token', async () => {
  const protectedApp = new Hono();
  protectedApp.get('/admin-data', ...adminGuard, (c) => c.json({ actorId: c.get('adminUser').id }));

  const response = await protectedApp.request('/admin-data');
  assert.equal(response.status, 401);
  assert.deepEqual((await response.json()).success, false);
});

test('sensitive admin endpoints reject anonymous requests', async () => {
  const paths = [
    '/api/admin',
    '/api/admin/dashboard',
    '/api/admin/vendors',
    '/api/admin/orders',
    '/api/admin/products',
    '/api/admin/settlements',
    '/api/admin/audit-logs',
    '/api/admin/employees',
    '/api/admin/auth/me',
  ];
  for (const path of paths) {
    const response = await app.request(path);
    assert.equal(response.status, 401, `${path} must reject anonymous requests`);
  }
});

test('health remains public and login route validates malformed requests', async () => {
  const health = await app.request('/health');
  const login = await app.request('/api/admin/auth/login', { method: 'POST' });
  assert.equal(health.status, 200);
  assert.equal(login.status, 400);
});
