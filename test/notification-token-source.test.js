import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routes = readFileSync(new URL('../src/routes/notifications.js', import.meta.url), 'utf8');

test('notification status and contacts include audience device tokens from the public backend table', () => {
  assert.match(routes, /FROM app\.device_tokens/);
  assert.match(routes, /d\.company_id IS NULL/);
  assert.match(routes, /d\.location_city, d\.location_region, d\.location_country/);
  assert.match(routes, /d\.token AS fcm_token/);
  assert.match(routes, /CASE WHEN n\.audience = 'merchant' THEN n\.location_city ELSE NULL::text END AS location_city/);
  assert.match(routes, /CASE WHEN n\.audience = 'merchant' THEN n\.location_region ELSE NULL::text END AS location_region/);
  assert.match(routes, /CASE WHEN n\.audience = 'merchant' THEN n\.location_country ELSE NULL::text END AS location_country/);
  assert.match(routes, /COALESCE\(NULLIF\(n\.company_name, ''\), NULLIF\(c\.display_name, ''\), c\.legal_name\) AS store_name/);
  assert.match(routes, /companyName: row\.store_name/);
});

test('notification status summarizes enabled customer tokens by approximate city without returning token values', () => {
  const statusRoute = routes.slice(routes.indexOf("notifications.get('/status'"), routes.indexOf("notifications.get('/contacts'"));
  assert.match(statusRoute, /COALESCE\(NULLIF\(BTRIM\(location_city\)/);
  assert.match(statusRoute, /FROM app\.device_tokens/);
  assert.match(statusRoute, /company_id IS NULL AND enabled IS TRUE/);
  assert.match(statusRoute, /customerCities: cityRows\.map/);
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

test('notification contacts return only a shortened token hint', () => {
  const contactsRoute = routes.slice(routes.indexOf("notifications.get('/contacts'"), routes.indexOf("notifications.post('/send'"));
  assert.match(contactsRoute, /LEFT\(fcm_token, 8\).*RIGHT\(fcm_token, 6\)/s);
  assert.doesNotMatch(contactsRoute, /items:\s*rows\s*\}\)/);
});
