import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routes = readFileSync(new URL('../src/routes/notifications.js', import.meta.url), 'utf8');

test('notification status and contacts include audience device tokens with governorate data', () => {
  assert.match(routes, /FROM app\.device_tokens/);
  assert.match(routes, /d\.company_id IS NULL/);
  assert.match(routes, /NULL::text AS location_city, NULL::text AS location_region, NULL::text AS location_country,[\s\S]*d\.governorate, d\.token AS fcm_token/);
  assert.match(routes, /d\.token AS fcm_token/);
  assert.match(routes, /CASE WHEN n\.audience = 'merchant' THEN n\.location_city ELSE NULL::text END AS location_city/);
  assert.match(routes, /CASE WHEN n\.audience = 'merchant' THEN n\.location_region ELSE NULL::text END AS location_region/);
  assert.match(routes, /CASE WHEN n\.audience = 'merchant' THEN n\.location_country ELSE NULL::text END AS location_country/);
  assert.match(routes, /COALESCE\(NULLIF\(n\.company_name, ''\), NULLIF\(c\.display_name, ''\), c\.legal_name\) AS store_name/);
  assert.match(routes, /companyName: row\.store_name/);
});

test('notification status summarizes enabled customer tokens by governorate without returning token values', () => {
  const statusRoute = routes.slice(routes.indexOf("notifications.get('/status'"), routes.indexOf("notifications.get('/contacts'"));
  assert.match(statusRoute, /COALESCE\(NULLIF\(BTRIM\(governorate\)/);
  assert.match(statusRoute, /FROM public\.notification_contacts n/);
  assert.match(statusRoute, /FROM app\.device_tokens/);
  assert.match(statusRoute, /SELECT DISTINCT ON \(token\) token, governorate/);
  assert.match(statusRoute, /d\.company_id IS NULL AND d\.enabled IS TRUE/);
  assert.match(statusRoute, /customerGovernorates: governorateRows\.map/);
  assert.match(statusRoute, /tokens: Number\(row\.tokens/);
  assert.doesNotMatch(statusRoute, /SELECT\s+fcm_token\s+FROM app\.device_tokens/);
});

test('legacy and public backend customer contacts are deduplicated by FCM token', () => {
  assert.match(routes, /NOT EXISTS \([\s\S]*FROM app\.device_tokens d WHERE d\.company_id IS NULL AND d\.token = n\.fcm_token/);
});

test('customer campaigns send to enabled public app device tokens and preserve legacy contacts', () => {
  const sendRoute = routes.slice(routes.indexOf("notifications.post('/send'"));
  assert.match(sendRoute, /FROM public\.notification_contacts/);
  assert.match(sendRoute, /UNION[\s\S]*FROM app\.device_tokens/);
  assert.match(sendRoute, /d\.enabled IS TRUE/);
  assert.match(sendRoute, /\$3::uuid IS NULL/);
});

test('customer campaign filtering uses a parameterized governorate for both token sources', () => {
  const sendRoute = routes.slice(routes.indexOf("notifications.post('/send'"));
  assert.match(sendRoute, /\$5::text IS NULL OR n\.governorate = \$5::text/);
  assert.match(sendRoute, /\$5::text IS NULL OR d\.governorate = \$5::text/);
  assert.match(sendRoute, /companyId, targetTokenRef, governorate/);
});

test('customer campaigns can be restricted to one opaque device reference without exposing full tokens', () => {
  assert.match(routes, /targetTokenRef/);
  assert.match(routes, /MD5\(fcm_token\) = \$4::text/);
  assert.match(routes, /MD5\(d\.token\) = \$4::text/);
  assert.match(routes, /MD5\(fcm_token\) ELSE NULL END AS token_ref/);
  assert.match(routes, /\^\[a-f0-9\]\{32\}\$/i);
});

test('notification contacts return no full or partial FCM token values', () => {
  const contactsRoute = routes.slice(routes.indexOf("notifications.get('/contacts'"), routes.indexOf("notifications.post('/send'"));
  assert.doesNotMatch(contactsRoute, /token_hint|tokenHint|LEFT\(fcm_token|RIGHT\(fcm_token/);
  assert.match(contactsRoute, /MD5\(fcm_token\) ELSE NULL END AS token_ref/);
  assert.doesNotMatch(contactsRoute, /items:\s*rows\s*\}\)/);
});

test('admin notifications expose merchant shipment activation requests without customer token data', () => {
  assert.match(routes, /notifications\.get\('\/shipment-requests'/);
  assert.match(routes, /FROM public\.shipment_activation_requests r/);
  assert.match(routes, /companyName: row\.company_name \|\| row\.legal_name/);
});
