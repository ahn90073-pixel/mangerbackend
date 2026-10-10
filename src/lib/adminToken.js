const encoder = new TextEncoder();
const ISSUER = 'mangerbackend-admin';
const TOKEN_TTL_SECONDS = 8 * 60 * 60;

function encodeBase64Url(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function signingKey(secret, usages) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('ADMIN_JWT_SECRET must contain at least 32 characters.');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function createAdminToken(user, secret, now = Math.floor(Date.now() / 1000)) {
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({
    sub: user.id,
    ver: Number(user.token_version || 0),
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    iss: ISSUER,
  }));
  const input = `${header}.${payload}`;
  const key = await signingKey(secret, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input)));
  return `${input}.${encodeBase64Url(signature)}`;
}

export async function verifyAdminToken(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    if (payload.iss !== ISSUER || typeof payload.sub !== 'string' || !Number.isInteger(payload.ver)) return null;
    if (!Number.isInteger(payload.exp) || payload.exp <= now || !Number.isInteger(payload.iat) || payload.iat > now + 60) return null;
    const key = await signingKey(secret, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, decodeBase64Url(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
    return valid ? payload : null;
  } catch {
    return null;
  }
}
