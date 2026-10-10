-- Role-based Mange admin accounts and governorate-scoped access.
-- Apply after 0001_admin_platform.sql and the Tager migrations 0001-0004.
-- Additive/idempotent: preserves all merchant and order data.
BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'employee')),
  assigned_governorates TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0),
  last_login_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (role <> 'employee' OR cardinality(assigned_governorates) > 0),
  CHECK (assigned_governorates <@ ARRAY[
    'القاهرة','الجيزة','الإسكندرية','الدقهلية','البحر الأحمر','البحيرة','الفيوم',
    'الغربية','الإسماعيلية','المنوفية','المنيا','القليوبية','الوادي الجديد','السويس',
    'أسوان','أسيوط','بني سويف','بورسعيد','دمياط','الشرقية','جنوب سيناء','كفر الشيخ',
    'مطروح','الأقصر','قنا','شمال سيناء','سوهاج'
  ]::TEXT[])
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower_uq ON public.admin_users (LOWER(email));
CREATE INDEX IF NOT EXISTS admin_users_active_role_idx ON public.admin_users (role, is_active);

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS governorate TEXT;
CREATE INDEX IF NOT EXISTS companies_governorate_idx ON public.companies (governorate);

-- Keep historical merchant-user actor columns intact; new dashboard identities use dedicated FK columns.
ALTER TABLE public.admin_audit_logs
  ADD COLUMN IF NOT EXISTS actor_admin_user_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS admin_audit_logs_admin_actor_idx ON public.admin_audit_logs (actor_admin_user_id, created_at DESC);
ALTER TABLE public.admin_company_settings
  ADD COLUMN IF NOT EXISTS updated_by_admin_user_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL;
ALTER TABLE public.admin_settlements
  ADD COLUMN IF NOT EXISTS created_by_admin_user_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL;

-- Ensure both existing tenant product tables and future tenants can retain the admin reviewer identity.
CREATE OR REPLACE FUNCTION public.ensure_mange_admin_product_schema(p_company_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_schema TEXT;
  v_products_oid OID;
  v_constraint RECORD;
  v_has_rejected_status BOOLEAN;
BEGIN
  SELECT tenant_schema_name INTO v_schema FROM public.companies WHERE id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company % not found', p_company_id USING ERRCODE = 'P0002';
  END IF;
  IF v_schema !~ '^tenant_[a-z0-9_]{1,54}$' THEN
    RAISE EXCEPTION 'Unsafe tenant schema for company %', p_company_id;
  END IF;
  v_products_oid := to_regclass(format('%I.products', v_schema));
  IF v_products_oid IS NULL THEN
    RAISE EXCEPTION 'Missing tenant products table for company %; apply Tager migration 0003 first', p_company_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_schema, 0));
  EXECUTE format($sql$
    ALTER TABLE %I.products
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS reviewed_by_admin_user_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS admin_kept BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS admin_archived_at TIMESTAMPTZ
  $sql$, v_schema);

  SELECT COALESCE(BOOL_OR(pg_get_constraintdef(oid) ILIKE '%rejected%'), FALSE)
    INTO v_has_rejected_status
    FROM pg_constraint
    WHERE conrelid = v_products_oid AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%';
  IF NOT v_has_rejected_status THEN
    FOR v_constraint IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = v_products_oid AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%status%'
    LOOP
      EXECUTE format('ALTER TABLE %I.products DROP CONSTRAINT %I', v_schema, v_constraint.conname);
    END LOOP;
    EXECUTE format(
      'ALTER TABLE %I.products ADD CONSTRAINT products_status_check CHECK (status IN (''draft'', ''pending'', ''active'', ''archived'', ''rejected''))',
      v_schema
    );
  END IF;
  EXECUTE format('UPDATE %I.products SET published_at = COALESCE(published_at, created_at) WHERE status = ''active''', v_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS products_admin_review_idx ON %I.products (status, created_at DESC)', v_schema);
END
$function$;
REVOKE ALL ON FUNCTION public.ensure_mange_admin_product_schema(UUID) FROM PUBLIC;

DO $migration$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT id FROM public.companies ORDER BY created_at, id LOOP
    PERFORM public.ensure_mange_admin_product_schema(tenant.id);
  END LOOP;
END
$migration$;

COMMIT;
