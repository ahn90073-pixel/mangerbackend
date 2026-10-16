import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routes = readFileSync(new URL('../src/routes/notifications.js', import.meta.url), 'utf8');

test('notification status and contacts include audience device tokens from the public backend table', () => {
  assert.match(routes, /FROM app\.device_tokens/);
  assert.match(routes, /d\.company_id IS NULL/);
  assert.match(routes, /d\.location_city, d\.location_region, d\.location_country/);
  assert.match(routes, /d\.token AS fcm_token/);
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
