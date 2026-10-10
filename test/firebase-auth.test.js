import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupFirebaseGoogleUser, parseAdminGoogleEmails } from '../src/lib/firebaseAuth.js';

test('admin Gmail allow-list is normalized, unique, and limited to three addresses', () => {
  assert.deepEqual(parseAdminGoogleEmails('Admin1@gmail.com, admin2@gmail.com,admin3@gmail.com'), [
    'admin1@gmail.com', 'admin2@gmail.com', 'admin3@gmail.com',
  ]);
  assert.deepEqual(parseAdminGoogleEmails(' ADMIN1@gmail.com,admin1@gmail.com '), ['admin1@gmail.com']);
  assert.equal(parseAdminGoogleEmails('admin@gmail.com,second@gmail.com,third@gmail.com,fourth@gmail.com'), null);
  assert.equal(parseAdminGoogleEmails('person@example.com'), null);
  assert.equal(parseAdminGoogleEmails(''), null);
});

test('Firebase lookup accepts only verified Google-provider identities', async () => {
  const fetchStub = async () => new Response(JSON.stringify({ users: [{
    localId: 'firebase-uid-123', email: 'ADMIN@gmail.com', emailVerified: true,
    displayName: 'Admin User', providerUserInfo: [{ providerId: 'google.com' }],
  }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const identity = await lookupFirebaseGoogleUser('x'.repeat(120), 'firebase-key', fetchStub);
  assert.deepEqual(identity, { uid: 'firebase-uid-123', email: 'admin@gmail.com', fullName: 'Admin User' });

  const nonGoogleFetch = async () => new Response(JSON.stringify({ users: [{
    localId: 'firebase-uid-123', email: 'admin@gmail.com', emailVerified: true,
    providerUserInfo: [{ providerId: 'password' }],
  }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal(await lookupFirebaseGoogleUser('x'.repeat(120), 'firebase-key', nonGoogleFetch), null);
});

