const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIREBASE_ACCOUNT_LOOKUP = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';

export class FirebaseConfigurationError extends Error {}
export class FirebaseServiceError extends Error {}

export function parseFirebaseAdminEmails(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return [];
  const emails = rawValue.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails.some((email) => email.length > 254 || !EMAIL_PATTERN.test(email))) {
    throw new FirebaseConfigurationError('FIREBASE_ADMIN_EMAILS contains an invalid email address.');
  }
  const unique = [...new Set(emails)];
  if (unique.length !== emails.length) {
    throw new FirebaseConfigurationError('FIREBASE_ADMIN_EMAILS must not contain duplicate email addresses.');
  }
  if (unique.length > 3) {
    throw new FirebaseConfigurationError('FIREBASE_ADMIN_EMAILS can contain at most three admin accounts.');
  }
  return unique;
}

function decodeClaims(idToken, projectId, nowSeconds) {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))));
    if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) return null;
    if (!Number.isInteger(claims.exp) || claims.exp <= nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}

export async function verifyFirebaseIdToken(idToken, {
  apiKey,
  projectId,
  fetchImpl = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  if (!apiKey || !projectId) {
    throw new FirebaseConfigurationError('Firebase API key and project ID are required.');
  }
  if (typeof idToken !== 'string' || idToken.length > 12_000) return null;
  const claims = decodeClaims(idToken, projectId, nowSeconds);
  if (!claims) return null;

  let response;
  try {
    response = await fetchImpl(`${FIREBASE_ACCOUNT_LOOKUP}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ idToken }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new FirebaseServiceError('Firebase account verification is temporarily unavailable.');
  }
  if (response.status === 400) {
    const errorPayload = await response.json().catch(() => null);
    const errorCode = errorPayload?.error?.message;
    if (['API_KEY_INVALID', 'PROJECT_NOT_FOUND', 'CONFIGURATION_NOT_FOUND'].includes(errorCode)) {
      throw new FirebaseConfigurationError('Firebase project configuration is invalid.');
    }
    return null;
  }
  if (response.status === 401) return null;
  if (!response.ok) throw new FirebaseServiceError(`Firebase account verification returned HTTP ${response.status}.`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new FirebaseServiceError('Firebase returned an unreadable verification response.');
  }
  const user = Array.isArray(payload?.users) ? payload.users[0] : null;
  if (!user || user.localId !== claims.sub || typeof user.email !== 'string') return null;
  if (claims.email && claims.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) return null;

  return {
    uid: user.localId,
    email: user.email.trim().toLowerCase(),
    displayName: typeof user.displayName === 'string' ? user.displayName.trim() : '',
    emailVerified: user.emailVerified === true,
    disabled: user.disabled === true,
  };
}
