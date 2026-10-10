import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.FIREBASE_WEB_API_KEY;
const projectId = process.env.FIREBASE_PROJECT_ID;
const allowedEmails = (process.env.FIREBASE_ADMIN_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() ?? '';
const password = process.env.INITIAL_ADMIN_PASSWORD ?? '';
const loginUrl = 'https://mangerbackend.ahn90073.workers.dev/api/admin/auth/firebase-login';

if (!databaseUrl || !apiKey || !projectId || !email || !password || !allowedEmails.includes(email)) {
  console.error('Missing Firebase/Neon CI configuration or INITIAL_ADMIN_EMAIL is not in FIREBASE_ADMIN_EMAILS.');
  process.exit(1);
}

try {
  const firebaseResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
    signal: AbortSignal.timeout(20000),
  });
  const firebasePayload = await firebaseResponse.json().catch(() => null);
  const idToken = firebasePayload?.idToken;
  if (!firebaseResponse.ok || typeof idToken !== 'string') {
    console.error(`Firebase CI sign-in failed with HTTP ${firebaseResponse.status}. Response content was not printed.`);
    process.exit(1);
  }

  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => null);
  const data = payload?.data ?? payload;
  if (!response.ok || payload?.success === false || !data?.token || data?.user?.role !== 'super_admin') {
    const requestId = response.headers.get('cf-ray') || 'unavailable';
    console.error(`Firebase token exchange failed with HTTP ${response.status} (Cloudflare request ID: ${requestId}). No token or response body was printed.`);
    process.exit(1);
  }

  const sql = neon(databaseUrl);
  const [user] = await sql`
    SELECT role, is_active, auth_provider
    FROM public.admin_users
    WHERE LOWER(email) = ${email}
    LIMIT 1
  `;
  if (!user || user.role !== 'super_admin' || !user.is_active || user.auth_provider !== 'firebase') {
    console.error('Neon did not persist the Firebase admin identity as an active super-admin. No sensitive values were printed.');
    process.exit(1);
  }
  console.log('Firebase admin login check passed. Neon role and active status verified; ID token and session token were discarded.');
} catch (error) {
  const safeCode = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(error.code)
    ? `; error code ${error.code}`
    : '';
  const safeName = typeof error?.name === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(error.name)
    ? error.name
    : 'unknown error';
  console.error(`Firebase admin login diagnosis failed (${safeName}${safeCode}). Credentials and tokens were not printed.`);
  process.exit(1);
}
