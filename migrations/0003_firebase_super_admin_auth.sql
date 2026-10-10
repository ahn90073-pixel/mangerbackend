-- Firebase-backed super-admin sign-in with Neon-owned roles and a hard limit of three admins.
-- Apply after 0001_admin_platform.sql and 0002_admin_auth_governorates.sql.
BEGIN;

ALTER TABLE public.admin_users
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS firebase_uid TEXT,
  ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password';

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

CREATE TABLE IF NOT EXISTS public.admin_super_admin_slots (
  slot SMALLINT PRIMARY KEY CHECK (slot BETWEEN 1 AND 3),
  admin_user_id UUID UNIQUE REFERENCES public.admin_users(id) ON DELETE SET NULL
);
INSERT INTO public.admin_super_admin_slots (slot) VALUES (1), (2), (3)
ON CONFLICT (slot) DO NOTHING;

DO $migration$
DECLARE
  current_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO current_count
  FROM public.admin_users WHERE role = 'super_admin';
  IF current_count > 3 THEN
    RAISE EXCEPTION 'Firebase admin migration supports at most three super-admin accounts; found %', current_count;
  END IF;

  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id)::SMALLINT AS slot
    FROM public.admin_users
    WHERE role = 'super_admin'
  )
  UPDATE public.admin_super_admin_slots AS slots
  SET admin_user_id = ranked.id
  FROM ranked
  WHERE slots.slot = ranked.slot AND slots.admin_user_id IS NULL;
END
$migration$;

CREATE OR REPLACE FUNCTION public.reserve_mange_super_admin_slot(p_admin_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  free_slot SMALLINT;
BEGIN
  IF EXISTS (SELECT 1 FROM public.admin_super_admin_slots WHERE admin_user_id = p_admin_user_id) THEN
    RETURN;
  END IF;

  SELECT slot INTO free_slot
  FROM public.admin_super_admin_slots
  WHERE admin_user_id IS NULL
  ORDER BY slot
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF free_slot IS NULL THEN
    RAISE EXCEPTION 'Maximum of three super-admin accounts reached' USING ERRCODE = '23514';
  END IF;

  UPDATE public.admin_super_admin_slots
  SET admin_user_id = p_admin_user_id
  WHERE slot = free_slot;
END
$function$;

CREATE OR REPLACE FUNCTION public.sync_mange_super_admin_slot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.role = 'super_admin' AND NEW.role <> 'super_admin' THEN
    UPDATE public.admin_super_admin_slots SET admin_user_id = NULL WHERE admin_user_id = NEW.id;
    RETURN NEW;
  END IF;
  IF NEW.role = 'super_admin' THEN
    PERFORM public.reserve_mange_super_admin_slot(NEW.id);
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS admin_users_super_admin_slot_trg ON public.admin_users;
CREATE TRIGGER admin_users_super_admin_slot_trg
AFTER INSERT OR UPDATE OF role ON public.admin_users
FOR EACH ROW EXECUTE FUNCTION public.sync_mange_super_admin_slot();

CREATE OR REPLACE FUNCTION public.link_firebase_super_admin(
  p_firebase_uid TEXT,
  p_email TEXT,
  p_full_name TEXT
) RETURNS public.admin_users
LANGUAGE plpgsql
AS $function$
DECLARE
  admin_row public.admin_users%ROWTYPE;
  existing_slot SMALLINT;
BEGIN
  IF p_firebase_uid IS NULL OR length(p_firebase_uid) < 1 OR length(p_firebase_uid) > 128
     OR p_email IS NULL OR length(p_email) > 254 OR position('@' IN p_email) < 2 THEN
    RAISE EXCEPTION 'Invalid Firebase admin identity' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO admin_row
  FROM public.admin_users
  WHERE firebase_uid = p_firebase_uid
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF admin_row.role <> 'super_admin' OR lower(admin_row.email) <> lower(p_email) THEN
      RAISE EXCEPTION 'Firebase identity is already linked to a different account' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO admin_row
    FROM public.admin_users
    WHERE lower(email) = lower(p_email)
    LIMIT 1
    FOR UPDATE;

    IF FOUND AND admin_row.role <> 'super_admin' THEN
      RAISE EXCEPTION 'Email belongs to a non-admin account' USING ERRCODE = '23514';
    END IF;
    IF FOUND AND admin_row.firebase_uid IS NOT NULL AND admin_row.firebase_uid <> p_firebase_uid THEN
      RAISE EXCEPTION 'Admin email is already linked to another Firebase identity' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF admin_row.id IS NOT NULL THEN
    SELECT slot INTO existing_slot
    FROM public.admin_super_admin_slots
    WHERE admin_user_id = admin_row.id;

    IF existing_slot IS NULL THEN
      PERFORM public.reserve_mange_super_admin_slot(admin_row.id);
    END IF;

    UPDATE public.admin_users
    SET firebase_uid = p_firebase_uid,
        auth_provider = 'firebase',
        password_hash = NULL,
        token_version = CASE
          WHEN auth_provider <> 'firebase' OR firebase_uid IS DISTINCT FROM p_firebase_uid
          THEN token_version + 1
          ELSE token_version
        END,
        full_name = COALESCE(NULLIF(trim(p_full_name), ''), full_name),
        updated_at = NOW()
    WHERE id = admin_row.id
    RETURNING * INTO admin_row;
    RETURN admin_row;
  END IF;

  INSERT INTO public.admin_users (
    email, full_name, password_hash, role, assigned_governorates,
    firebase_uid, auth_provider
  ) VALUES (
    lower(p_email), COALESCE(NULLIF(trim(p_full_name), ''), split_part(lower(p_email), '@', 1)),
    NULL, 'super_admin', ARRAY[]::TEXT[], p_firebase_uid, 'firebase'
  ) RETURNING * INTO admin_row;

  RETURN admin_row;
END
$function$;

REVOKE ALL ON FUNCTION public.link_firebase_super_admin(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_mange_super_admin_slot(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_mange_super_admin_slot() FROM PUBLIC;

COMMIT;
