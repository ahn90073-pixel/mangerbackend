-- Google/Firebase authentication for super admins; employee password accounts remain unchanged.
-- Additive and re-runnable. Apply after 0002_admin_auth_governorates.sql.
BEGIN;

-- Google-only administrator accounts do not need a password hash.
ALTER TABLE public.admin_users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE public.admin_users
  ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password',
  ADD COLUMN IF NOT EXISTS firebase_uid TEXT;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.admin_users'::regclass
      AND conname = 'admin_users_auth_provider_check'
  ) THEN
    ALTER TABLE public.admin_users
      ADD CONSTRAINT admin_users_auth_provider_check CHECK (auth_provider IN ('password', 'firebase'));
  END IF;
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_firebase_uid_uq
  ON public.admin_users (firebase_uid) WHERE firebase_uid IS NOT NULL;

-- Three persistent seats serialize concurrent first-time Google admin provisioning.
CREATE TABLE IF NOT EXISTS public.admin_google_admin_slots (
  slot SMALLINT PRIMARY KEY CHECK (slot BETWEEN 1 AND 3),
  email TEXT UNIQUE,
  reserved_at TIMESTAMPTZ
);
INSERT INTO public.admin_google_admin_slots (slot) VALUES (1), (2), (3)
  ON CONFLICT (slot) DO NOTHING;

-- Preserve up to three existing super-admin accounts as occupied slots; never remove accounts.
WITH legacy_admins AS (
  SELECT LOWER(email) AS email, ROW_NUMBER() OVER (ORDER BY created_at, id)::SMALLINT AS slot
  FROM public.admin_users
  WHERE role = 'super_admin'
  ORDER BY created_at, id
  LIMIT 3
)
UPDATE public.admin_google_admin_slots AS slots
SET email = legacy_admins.email, reserved_at = NOW()
FROM legacy_admins
WHERE slots.slot = legacy_admins.slot AND slots.email IS NULL;

COMMIT;
