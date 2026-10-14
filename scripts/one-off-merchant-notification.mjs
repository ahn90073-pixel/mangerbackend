import { neon } from '@neondatabase/serverless';
import { createSign } from 'node:crypto';

const sql = neon(process.env.DATABASE_URL);
const [contact] = await sql`
  SELECT fcm_token
  FROM public.notification_contacts
  WHERE audience = 'merchant'
    AND app_name = 'taget'
    AND push_enabled IS TRUE
    AND fcm_token IS NOT NULL
    AND fcm_token <> ''
  ORDER BY updated_at DESC
  LIMIT 1
`;
if (!contact?.fcm_token) throw new Error('No enabled merchant token found');

const account = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
const now = Math.floor(Date.now() / 1000);
const base64url = (value) => Buffer.from(value).toString('base64url');
const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
  iss: account.client_email,
  scope: 'https://www.googleapis.com/auth/firebase.messaging',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 3600,
}))}`;
const signer = createSign('RSA-SHA256');
signer.update(unsigned);
const assertion = `${unsigned}.${signer.sign(account.private_key.replace(/\\n/g, '\n'), 'base64url')}`;
const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }),
});
if (!tokenResponse.ok) throw new Error(`FCM OAuth failed (${tokenResponse.status})`);
const { access_token: accessToken } = await tokenResponse.json();
const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: { token: contact.fcm_token, notification: { title: 'اختبار', body: 'هذا إشعار تجريبي' } } }),
});
if (!response.ok) throw new Error(`FCM send failed (${response.status}): ${await response.text()}`);
console.log(JSON.stringify({ sent: 1, audience: 'merchant', title: 'اختبار' }));
