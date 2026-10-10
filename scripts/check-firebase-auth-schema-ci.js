import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Missing DATABASE_URL GitHub Actions secret.');
  process.exit(1);
}

try {
  const sql = neon(databaseUrl);
  const [schema] = await sql`
    SELECT
      to_regclass('public.admin_users') IS NOT NULL AS admin_users_exists,
      to_regclass('public.admin_super_admin_slots') IS NOT NULL AS slots_exist,
      to_regprocedure('public.link_firebase_super_admin(text,text,text)') IS NOT NULL AS firebase_link_exists,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='admin_users' AND column_name='firebase_uid'
      ) AS firebase_uid_exists,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='admin_users' AND column_name='auth_provider'
      ) AS auth_provider_exists,
      (SELECT COUNT(*) = 3 FROM public.admin_super_admin_slots) AS three_slots_exist
  `;
  const valid = schema?.admin_users_exists && schema?.slots_exist && schema?.firebase_link_exists
    && schema?.firebase_uid_exists && schema?.auth_provider_exists && schema?.three_slots_exist;
  if (!valid) {
    console.error('Neon is missing the Firebase admin-auth schema. Select apply_admin_migration or apply migrations/0001–0003 manually before deploying.');
    process.exit(1);
  }
  console.log('Neon Firebase admin-auth schema is ready; deployment may proceed.');
} catch (error) {
  const safeCode = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(error.code)
    ? `; database error code ${error.code}`
    : '';
  console.error(`Neon schema preflight failed${safeCode}. The Worker was not deployed.`);
  process.exit(1);
}
