import { neon } from '@neondatabase/serverless';
import { hashPassword } from '../src/lib/password.js';

const databaseUrl = process.env.DATABASE_URL;
const fullName = process.env.INITIAL_ADMIN_NAME?.trim() ?? '';
const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() ?? '';
const password = process.env.INITIAL_ADMIN_PASSWORD ?? '';

if (!databaseUrl || !fullName || !email || !password) {
  console.error('Missing required GitHub Actions secrets or workflow inputs.');
  process.exit(1);
}
if (fullName.length < 2 || fullName.length > 160) {
  console.error('Admin name must be between 2 and 160 characters.');
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
  console.error('Enter a valid admin email address.');
  process.exit(1);
}
if (password.length < 12 || password.length > 1024) {
  console.error('The initial admin password must be between 12 and 1024 characters.');
  process.exit(1);
}

try {
  const sql = neon(databaseUrl);
  const [existing] = await sql`SELECT COUNT(*)::int AS count FROM public.admin_users WHERE role = 'super_admin'`;
  if (Number(existing?.count ?? 0) > 0) {
    console.error('A super admin already exists. No account was created.');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const [user] = await sql`
    INSERT INTO public.admin_users (email, full_name, password_hash, role, assigned_governorates)
    VALUES (${email}, ${fullName}, ${passwordHash}, 'super_admin', ARRAY[]::TEXT[])
    RETURNING email
  `;
  if (!user) throw new Error('Insert did not return a created account.');
  console.log('Initial super admin created successfully.');
} catch {
  console.error('Admin creation failed. Confirm DATABASE_URL is correct and migration 0002 has been applied. No credentials were printed.');
  process.exit(1);
}
