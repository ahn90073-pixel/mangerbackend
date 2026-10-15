const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_AUDIENCE = 'https://oauth2.googleapis.com/token';

function base64UrlEncode(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeServiceAccount(env, appName = 'taget') {
  const raw = appName === 'online-store'
    ? env?.FCM_PUBLIC_SERVICE_ACCOUNT_JSON
    : env?.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const account = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!account || typeof account !== 'object') return null;
    const privateKey = String(account.private_key || '').replace(/\\n/g, '\n');
    if (!account.project_id || !account.client_email || !privateKey.includes('BEGIN PRIVATE KEY')) return null;
    return { projectId: String(account.project_id), clientEmail: String(account.client_email), privateKey };
  } catch {
    return null;
  }
}

export function isFcmConfigured(env, appName = 'taget') {
  return Boolean(decodeServiceAccount(env, appName));
}

async function createAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64UrlEncode(JSON.stringify({
    iss: account.clientEmail,
    scope: FCM_SCOPE,
    aud: TOKEN_AUDIENCE,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const pem = account.privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(pem.replace(/-/g, '+').replace(/_/g, '/'));
  const keyBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
  const response = await fetch(TOKEN_AUDIENCE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) throw new Error('FCM OAuth token request failed');
  const payload = await response.json();
  if (!payload?.access_token) throw new Error('FCM OAuth token response was invalid');
  return payload.access_token;
}

export async function sendFcmNotification(env, tokens, { title, body, appName = 'taget' }) {
  const account = decodeServiceAccount(env, appName);
  const cleanTokens = [...new Set((tokens || []).filter((token) => typeof token === 'string' && token.trim()))];
  if (!account) return { configured: false, sent: 0, failed: cleanTokens.length };
  if (!cleanTokens.length) return { configured: true, sent: 0, failed: 0 };

  let accessToken;
  try {
    accessToken = await createAccessToken(account);
  } catch {
    return { configured: true, sent: 0, failed: cleanTokens.length };
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`;
  let sent = 0;
  let failed = 0;
  for (let index = 0; index < cleanTokens.length; index += 25) {
    const batch = cleanTokens.slice(index, index + 25);
    const results = await Promise.all(batch.map(async (token) => {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token,
              notification: { title, body },
              android: {
                priority: 'HIGH',
                notification: {
                  channel_id: 'store-default',
                  sound: 'default',
                  default_sound: true,
                  default_vibrate_timings: true,
                  notification_priority: 'PRIORITY_HIGH',
                },
              },
            },
          }),
        });
        return response.ok;
      } catch {
        return false;
      }
    }));
    sent += results.filter(Boolean).length;
    failed += results.length - results.filter(Boolean).length;
  }
  return { configured: true, sent, failed };
}
