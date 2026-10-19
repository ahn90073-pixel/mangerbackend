import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/index.js';
import { mapPromotion, validatePromotion } from '../src/routes/promotions.js';

const mediaKey = '11111111-1111-4111-8111-111111111111';
const validPromotion = {
  title: 'Summer sale',
  subtitle: 'Limited time',
  description: 'A promotion',
  ctaLabel: 'Shop now',
  targetUrl: '/offers/summer',
  mediaUrl: 'https://res.cloudinary.com/demo/image/upload/v1/promotions/summer.jpg',
  mediaKey,
  mediaType: 'image',
  theme: 'blue',
  isActive: true,
  sortOrder: 2,
  startsAt: '2026-06-01T00:00:00Z',
  endsAt: '2026-07-01T00:00:00Z',
};

test('promotion validation accepts Cloudinary image URLs and rejects unsafe media/date/order values', () => {
  assert.equal(validatePromotion(validPromotion).errors, undefined);
  assert.ok(validatePromotion({ ...validPromotion, mediaUrl: 'https://example.com/image/upload/a.jpg' }).errors.length);
  assert.ok(validatePromotion({ ...validPromotion, mediaType: 'video' }).errors.length);
  assert.ok(validatePromotion({ ...validPromotion, mediaKey: 'not-a-uuid' }).errors.length);
  assert.ok(validatePromotion({ ...validPromotion, sortOrder: 1.5 }).errors.length);
  assert.ok(validatePromotion({ ...validPromotion, startsAt: '2026-08-01', endsAt: '2026-07-01' }).errors.length);
});

test('promotion creation requires the complete media bundle and a UUID media key', () => {
  assert.ok(validatePromotion({ ...validPromotion, mediaUrl: undefined }).errors.some((error) => error.includes('mediaUrl is required')));
  assert.ok(validatePromotion({ ...validPromotion, mediaType: undefined }).errors.some((error) => error.includes('mediaType is required')));
  assert.ok(validatePromotion({ ...validPromotion, mediaKey: null }).errors.some((error) => error.includes('mediaKey must be a UUID')));
});

test('promotion updates preserve media when no media field is supplied and require a complete replacement bundle', () => {
  const unchanged = validatePromotion({ title: 'Updated title' }, { partial: true, existing: validPromotion });
  assert.deepEqual(unchanged.values, { title: 'Updated title' });
  assert.ok(validatePromotion({ mediaUrl: validPromotion.mediaUrl }, { partial: true, existing: validPromotion }).errors.length);
  const replacement = validatePromotion({
    mediaUrl: 'https://res.cloudinary.com/demo/video/upload/v1/promotions/summer.mp4',
    mediaKey,
    mediaType: 'video',
  }, { partial: true, existing: validPromotion });
  assert.deepEqual(replacement.values, {
    mediaUrl: 'https://res.cloudinary.com/demo/video/upload/v1/promotions/summer.mp4',
    mediaKey,
    mediaType: 'video',
  });
});

test('promotion API output includes Cloudinary media key and type, including deleted records', () => {
  const mapped = mapPromotion({ id: mediaKey, ...validPromotion, createdAt: null, updatedAt: null });
  assert.equal(mapped.mediaKey, mediaKey);
  assert.equal(mapped.mediaType, 'image');
});

test('all promotion CRUD endpoints require a super-admin session', async () => {
  const requests = [
    ['GET', '/api/admin/promotions'],
    ['POST', '/api/admin/promotions'],
    ['PATCH', `/api/admin/promotions/${mediaKey}`],
    ['DELETE', `/api/admin/promotions/${mediaKey}`],
  ];
  for (const [method, path] of requests) {
    const response = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({}),
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});
