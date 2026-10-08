import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import app from '../src/index.js';
import { adminGuard } from '../src/middleware/adminAuth.js';

test('public admin middleware accepts a request with no authorization header', async () => {
  const publicApp = new Hono();
  publicApp.get('/admin-data', ...adminGuard, (c) => c.json({ actorId: c.get('adminUser').id }));

  const response = await publicApp.request('/admin-data');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { actorId: null });
});

test('login and current-user endpoints are not exposed', async () => {
  const login = await app.request('/api/admin/auth/login', { method: 'POST' });
  const currentUser = await app.request('/api/admin/auth/me');
  assert.equal(login.status, 404);
  assert.equal(currentUser.status, 404);
});
