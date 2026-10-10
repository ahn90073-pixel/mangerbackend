import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupFirebaseGoogleUser } from '../src/lib/firebaseAuth.js';
import { reserveGoogleAdminSlot } from '../src/routes/auth.js';

function createSlotsDb() {
  const slots = [1, 2, 3].map((slot) => ({ slot, email: null }));
  return {
    slots,
    async query(sql, params = []) {
      if (sql.includes('SELECT slot FROM public.admin_google_admin_slots WHERE email = $1 LIMIT 1')) {
        const existing = slots.find((seat) => seat.email === params[0]);
        return existing ? [{ slot: existing.slot }] : [];
      }
      if (sql.includes('UPDATE public.admin_google_admin_slots') && sql.includes('RETURNING slot')) {
        const openSeat = slots.find((seat) => seat.email === null);
        if (!openSeat) return [];
        openSeat.email = params[0];
        return [{ slot: openSeat.slot }];
      }
      throw new Error(`Unexpected SQL in seat test: ${sql}`);
    },
  };
}

test('only verified Google-provider identities are accepted, without a pre-registered email list', async () => {
  const fetchStub = async () => new Response(JSON.stringify({ users: [{
    localId: 'firebase-uid-123', email: 'first-admin@example.org', emailVerified: true,
    displayName: 'First Admin', providerUserInfo: [{ providerId: 'google.com' }],
  }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const identity = await lookupFirebaseGoogleUser('x'.repeat(120), 'firebase-key', fetchStub);
  assert.deepEqual(identity, { uid: 'firebase-uid-123', email: 'first-admin@example.org', fullName: 'First Admin' });

  const nonGoogleFetch = async () => new Response(JSON.stringify({ users: [{
    localId: 'firebase-uid-123', email: 'first-admin@example.org', emailVerified: true,
    providerUserInfo: [{ providerId: 'password' }],
  }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal(await lookupFirebaseGoogleUser('x'.repeat(120), 'firebase-key', nonGoogleFetch), null);

  const unverifiedFetch = async () => new Response(JSON.stringify({ users: [{
    localId: 'firebase-uid-123', email: 'first-admin@example.org', emailVerified: false,
    providerUserInfo: [{ providerId: 'google.com' }],
  }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal(await lookupFirebaseGoogleUser('x'.repeat(120), 'firebase-key', unverifiedFetch), null);
});

test('the first three Google accounts claim permanent admin seats and the fourth is rejected', async () => {
  const db = createSlotsDb();
  const registrations = await Promise.all([
    reserveGoogleAdminSlot(db, 'first@example.org'),
    reserveGoogleAdminSlot(db, 'second@example.org'),
    reserveGoogleAdminSlot(db, 'third@example.org'),
    reserveGoogleAdminSlot(db, 'fourth@example.org'),
  ]);
  assert.equal(registrations.filter(Boolean).length, 3);
  assert.equal(registrations[3], false);
  assert.deepEqual(db.slots.map(({ email }) => email).sort(), [
    'first@example.org', 'second@example.org', 'third@example.org',
  ]);

  // An existing seat holder can sign in again, but a full set never accepts a new identity.
  assert.equal(await reserveGoogleAdminSlot(db, 'second@example.org'), true);
  assert.equal(await reserveGoogleAdminSlot(db, 'fourth@example.org'), false);
});
