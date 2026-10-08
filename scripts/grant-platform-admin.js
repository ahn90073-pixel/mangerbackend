import { neon } from '@neondatabase/serverless';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || process.argv[3] !== '--confirm') {
  console.error('Usage: DATABASE_URL=... node scripts/grant-platform-admin.js admin@example.com --confirm');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const sql = neon(process.env.DATABASE_URL);
const [user] = await sql`
  UPDATE public.users
  SET is_platform_admin = TRUE, updated_at = NOW()
  WHERE LOWER(email) = ${email}
  RETURNING id, email, full_name, is_platform_admin
`;
if (!user) {
  console.error('No existing account matched that email. Create the account through the trusted account flow first.');
  process.exit(1);
}
console.log(`Granted platform-admin access to ${user.email} (${user.id}).`);
