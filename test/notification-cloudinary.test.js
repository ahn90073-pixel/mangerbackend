import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const notificationsRoute = readFileSync(new URL('../src/routes/notifications.js', import.meta.url), 'utf8');
const fcm = readFileSync(new URL('../src/lib/fcm.js', import.meta.url), 'utf8');

test('campaign images use validated Cloudinary URLs and are sent directly to FCM', () => {
  assert.match(notificationsRoute, /hostname !== 'res\.cloudinary\.com'/);
  assert.match(notificationsRoute, /sendFcmNotification\(c\.env, tokens, \{ title: title\.trim\(\), body: body\.trim\(\), imageUrl, appName \}\)/);
  assert.doesNotMatch(notificationsRoute, /storeNotificationImage|NOTIFICATION_IMAGES/);
  assert.match(fcm, /notification: \{ title, body, \.\.\.\(imageUrl \? \{ image: imageUrl \} : \{\}\) \}/);
});
