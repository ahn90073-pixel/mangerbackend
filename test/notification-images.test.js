import test from 'node:test';
import assert from 'node:assert/strict';
import { getNotificationImage, storeNotificationImage } from '../src/lib/notificationImages.js';
import app from '../src/index.js';

function mockKv() {
  const entries = new Map();
  return {
    entries,
    async put(key, value, options) {
      entries.set(key, { value: value.slice(0), metadata: options.metadata, expirationTtl: options.expirationTtl });
    },
    async getWithMetadata(key) {
      const entry = entries.get(key);
      return entry ? { value: entry.value.slice(0), metadata: entry.metadata } : { value: null, metadata: null };
    },
  };
}

const imageData = `data:image/png;base64,${btoa('sample-image-binary')}`;

test('stores a notification image in KV and returns a token-protected HTTPS URL', async () => {
  const kv = mockKv();
  const url = await storeNotificationImage({ NOTIFICATION_IMAGES: kv }, imageData, 'flower.png', 'https://admin.example');
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/');
  const id = parts.at(-2);
  const token = parts.at(-1);
  const entry = kv.entries.get(`notification-image:${id}`);

  assert.equal(parsed.protocol, 'https:');
  assert.match(id, /^[0-9a-f-]{36}$/i);
  assert.match(token, /^[A-Za-z0-9_-]{40,50}$/);
  assert.equal(entry.metadata.contentType, 'image/png');
  assert.equal(entry.metadata.name, 'flowerpng');
  assert.equal(entry.expirationTtl, 180 * 24 * 60 * 60);
  assert.equal(JSON.stringify(entry.metadata).includes(token), false);
});

test('serves the stored image only when the URL token matches', async () => {
  const kv = mockKv();
  const url = await storeNotificationImage({ NOTIFICATION_IMAGES: kv }, imageData, 'flower.png', 'https://admin.example');
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/');
  const id = parts.at(-2);
  const token = parts.at(-1);
  const response = await getNotificationImage({ NOTIFICATION_IMAGES: kv }, id, token);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), 'sample-image-binary');
  assert.equal(await getNotificationImage({ NOTIFICATION_IMAGES: kv }, id, `${token.slice(0, -1)}x`), null);
  assert.equal(await getNotificationImage({ NOTIFICATION_IMAGES: kv }, id, token.slice(1)), null);
});

test('rejects invalid or oversized image data and missing KV configuration', async () => {
  const kv = mockKv();
  assert.equal(await storeNotificationImage({ NOTIFICATION_IMAGES: kv }, 'not-an-image', 'bad', 'https://admin.example'), null);
  assert.equal(kv.entries.size, 0);
  assert.equal(await storeNotificationImage({ NOTIFICATION_IMAGES: kv }, `data:image/jpeg;base64,${btoa('x'.repeat(1_500_001))}`, 'large', 'https://admin.example'), null);
  await assert.rejects(
    storeNotificationImage({}, imageData, 'flower.png', 'https://admin.example'),
    /NOTIFICATION_IMAGE_KV_NOT_CONFIGURED/,
  );
});

test('public Worker route serves tokenized images and hides invalid tokens', async () => {
  const kv = mockKv();
  const url = await storeNotificationImage({ NOTIFICATION_IMAGES: kv }, imageData, 'flower.png', 'https://mangerbackend.example');
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/');
  const id = parts.at(-2);
  const token = parts.at(-1);
  const valid = await app.fetch(new Request(url), { NOTIFICATION_IMAGES: kv });
  const invalid = await app.fetch(new Request(`${parsed.origin}/api/public/notification-images/${id}/${token}x`), { NOTIFICATION_IMAGES: kv });

  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('content-type'), 'image/png');
  assert.equal(await valid.text(), 'sample-image-binary');
  assert.equal(invalid.status, 404);
});
