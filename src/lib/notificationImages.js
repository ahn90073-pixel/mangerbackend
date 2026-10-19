const MAX_IMAGE_BYTES = 1_500_000;
const IMAGE_TTL_SECONDS = 180 * 24 * 60 * 60;
const KEY_PREFIX = 'notification-image:';

function parseImageData(imageData) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(imageData || ''));
  if (!match) return null;
  let binary;
  try {
    binary = atob(match[2]);
  } catch {
    return null;
  }
  if (binary.length === 0 || binary.length > MAX_IMAGE_BYTES) return null;
  return {
    contentType: match[1],
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  };
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function tokenDigest(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export async function storeNotificationImage(env, imageData, imageName, origin) {
  const image = parseImageData(imageData);
  if (!image) return null;
  if (!env?.NOTIFICATION_IMAGES?.put) throw new Error('NOTIFICATION_IMAGE_KV_NOT_CONFIGURED');

  const id = crypto.randomUUID();
  const token = randomToken();
  const extension = image.contentType.split('/')[1].replace('jpeg', 'jpg');
  const safeName = String(imageName || 'image').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'image';
  const value = image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength);
  await env.NOTIFICATION_IMAGES.put(`${KEY_PREFIX}${id}`, value, {
    expirationTtl: IMAGE_TTL_SECONDS,
    metadata: {
      contentType: image.contentType,
      extension,
      name: safeName,
      tokenHash: await tokenDigest(token),
    },
  });

  return `${origin}/api/public/notification-images/${id}/${token}`;
}

export async function getNotificationImage(env, id, token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || '')) || !/^[A-Za-z0-9_-]{40,50}$/.test(String(token || ''))) return null;
  if (!env?.NOTIFICATION_IMAGES?.getWithMetadata) return null;

  const { value, metadata } = await env.NOTIFICATION_IMAGES.getWithMetadata(
    `${KEY_PREFIX}${id}`,
    { type: 'arrayBuffer' },
  );
  if (!value || !metadata?.contentType || !metadata?.tokenHash) return null;
  if (!constantTimeEqual(metadata.tokenHash, await tokenDigest(token))) return null;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(metadata.contentType)) return null;

  return new Response(value, {
    headers: {
      'Content-Type': metadata.contentType,
      'Content-Length': String(value.byteLength),
      'Cache-Control': 'public, max-age=86400, s-maxage=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}
