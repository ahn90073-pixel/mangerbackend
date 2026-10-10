import { neon } from '@neondatabase/serverless';
import { verifyPassword } from '../src/lib/password.js';

const databaseUrl = process.env.DATABASE_URL;
const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() ?? '';
const password = process.env.INITIAL_ADMIN_PASSWORD ?? '';
const loginUrl = 'https://mangerbackend.ahn90073.workers.dev/api/admin/auth/login';

if (!databaseUrl || !email || !password) {
  console.error('Missing DATABASE_URL, INITIAL_ADMIN_EMAIL, or INITIAL_ADMIN_PASSWORD GitHub Actions secret.');
  process.exit(1);
}

try {
  const sql = neon(databaseUrl);
  const [user] = await sql`
    SELECT password_hash, role, is_active
    FROM public.admin_users
    WHERE LOWER(email) = ${email}
    LIMIT 1
  `;
  if (!user) {
    console.error('Database check failed: no account matches the configured email.');
    process.exit(1);
  }
  const passwordMatches = await verifyPassword(password, user.password_hash);
  console.log(`Database check: role=${user.role}; active=${Boolean(user.is_active)}; current password matches stored hash=${passwordMatches}.`);
  if (user.role !== 'super_admin' || !user.is_active || !passwordMatches) {
    console.error('Database credentials are not valid for an active super-admin. No sensitive values were printed.');
    process.exit(1);
  }

  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => null);
  const data = payload?.data ?? payload;
  if (!response.ok || payload?.success === false || !data?.token || !data?.user?.role) {
    console.error(`Database credentials match, but the deployed admin API rejected login with HTTP ${response.status}. Check the Worker database configuration. Response details and credentials were not printed.`);
    process.exit(1);
  }
  console.log(`Login check passed. Authenticated role: ${data.user.role}. Token was discarded and not logged.`);
} catch (error) {
  const safeCode = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(error.code)
    ? `; database error code ${error.code}`
    : '';
  const safeName = typeof error?.name === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(error.name)
    ? error.name
    : 'unknown error';
  console.error(`Login diagnosis failed (${safeName}${safeCode}). Credentials and response body were not printed.`);
  process.exit(1);
}
