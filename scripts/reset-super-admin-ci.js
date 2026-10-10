import { neon } from '@neondatabase/serverless';
import { hashPassword } from '../src/lib/password.js';

const databaseUrl = process.env.DATABASE_URL;
const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() ?? '';
const password = process.env.INITIAL_ADMIN_PASSWORD ?? '';

if (!databaseUrl || !email || !password) {
  console.error('Missing required GitHub Actions secrets.');
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
  console.error('The INITIAL_ADMIN_EMAIL secret is invalid.');
  process.exit(1);
}
if (password.length < 12 || password.length > 1024) {
  console.error('The replacement password must be between 12 and 1024 characters.');
  process.exit(1);
}

try {
  const sql = neon(databaseUrl);
  const passwordHash = await hashPassword(password);
  const [user] = await sql`
    UPDATE public.admin_users
    SET password_hash = ${passwordHash},
        token_version = token_version + 1,
        updated_at = NOW()
    WHERE LOWER(email) = ${email}
      AND role = 'super_admin'
      AND is_active = TRUE
    RETURNING id
  `;
  if (!user) {
    console.error('No active super-admin account matched. No password was changed.');
    process.exit(1);
  }
  console.log('Super-admin password updated successfully. Existing sessions were invalidated.');
} catch (error) {
  const safeCode = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(error.code)
    ? `; database error code ${error.code}`
    : '';
  console.error(`Password update failed${safeCode}. Check DATABASE_URL and database schema. No credentials were printed.`);
  process.exit(1);
}
