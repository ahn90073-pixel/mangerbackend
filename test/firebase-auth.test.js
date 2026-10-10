import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FirebaseConfigurationError,
  FirebaseServiceError,
  parseFirebaseAdminEmails,
  verifyFirebaseIdToken,
} from '../src/lib/firebaseAuth.js';

const projectId = 'mange-test-project';
const apiKey = 'public-test-api-key';

function makeIdToken(overrides = {}) {
  const payload = {
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: 'firebase-uid-1',
    email: 'admin@example.com',
    exp: 2_000_000_000,
    ...overrides,
  };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Firebase admin allowlist normalizes emails and permits no more than three unique accounts', () => {
  assert.deepEqual(parseFirebaseAdminEmails(' Admin@One.com, TWO@example.com '), ['admin@one.com', 'two@example.com']);
  assert.deepEqual(parseFirebaseAdminEmails(''), []);
  assert.throws(() => parseFirebaseAdminEmails('a@x.com,b@x.com,c@x.com,d@x.com'), FirebaseConfigurationError);
  assert.throws(() => parseFirebaseAdminEmails('a@x.com,A@x.com'), FirebaseConfigurationError);
  assert.throws(() => parseFirebaseAdminEmails('not-an-email'), FirebaseConfigurationError);
});

test('Firebase ID token is verified against configured project through accounts lookup', async () => {
  let requestUrl = '';
  let requestBody = null;
  const verified = await verifyFirebaseIdToken(makeIdToken(), {
    apiKey,
    projectId,
    fetchImpl: async (url, options) => {
      requestUrl = String(url);
      requestBody = JSON.parse(options.body);
      return jsonResponse({ users: [{
        localId: 'firebase-uid-1',
        email: 'Admin@example.com',
        emailVerified: true,
        disabled: false,
        displayName: 'Admin Name',
      }] });
    },
  });
  assert.equal(new URL(requestUrl).searchParams.get('key'), apiKey);
  assert.deepEqual(requestBody, { idToken: makeIdToken() });
  assert.deepEqual(verified, {
    uid: 'firebase-uid-1',
    email: 'admin@example.com',
    displayName: 'Admin Name',
    emailVerified: true,
    disabled: false,
  });
});

test('Firebase verifier rejects wrong project, expired token, mismatched user, or invalid credential', async () => {
  let lookupCount = 0;
  const fetchImpl = async () => {
    lookupCount += 1;
    return jsonResponse({ users: [{
      localId: 'firebase-uid-1', email: 'admin@example.com', emailVerified: true, disabled: false,
    }] });
  };
  assert.equal(await verifyFirebaseIdToken(makeIdToken({ aud: 'another-project' }), { apiKey, projectId, fetchImpl }), null);
  assert.equal(await verifyFirebaseIdToken(makeIdToken({ exp: 1_800_000_000 }), { apiKey, projectId, fetchImpl, nowSeconds: 1_900_000_000 }), null);
  assert.equal(await verifyFirebaseIdToken(makeIdToken(), {
    apiKey, projectId,
    fetchImpl: async () => jsonResponse({ users: [{ localId: 'someone-else', email: 'admin@example.com' }] }),
  }), null);
  assert.equal(await verifyFirebaseIdToken(makeIdToken(), {
    apiKey, projectId, fetchImpl: async () => jsonResponse({ error: { message: 'INVALID_ID_TOKEN' } }, 400),
  }), null);
  await assert.rejects(
    verifyFirebaseIdToken(makeIdToken(), {
      apiKey, projectId, fetchImpl: async () => jsonResponse({ error: { message: 'API_KEY_INVALID' } }, 400),
    }),
    FirebaseConfigurationError,
  );
  assert.equal(lookupCount, 0);
});

test('Firebase verifier treats provider outages and missing configuration as unavailable', async () => {
  await assert.rejects(
    verifyFirebaseIdToken(makeIdToken(), { projectId, fetchImpl: async () => jsonResponse({}) }),
    FirebaseConfigurationError,
  );
  await assert.rejects(
    verifyFirebaseIdToken(makeIdToken(), { apiKey, projectId, fetchImpl: async () => { throw new Error('network'); } }),
    FirebaseServiceError,
  );
  await assert.rejects(
    verifyFirebaseIdToken(makeIdToken(), { apiKey, projectId, fetchImpl: async () => jsonResponse({}, 503) }),
    FirebaseServiceError,
  );
});
