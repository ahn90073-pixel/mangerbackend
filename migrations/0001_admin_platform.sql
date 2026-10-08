-- Mange admin platform tables and tenant-product moderation fields.
-- Apply only after the Tager backend migrations 0001, 0002, and 0003.
-- Safe to re-run; this migration never deletes business data.
BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_company_settings (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  commission_type TEXT NOT NULL DEFAULT 'percentage' CHECK (commission_type IN ('percentage', 'fixed')),
  commission_value NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (commission_value >= 0),
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (commission_type <> 'percentage' OR commission_value <= 100)
);

CREATE TABLE IF NOT EXISTS public.admin_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
  net_amount NUMERIC(14,2) NOT NULL CHECK (net_amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'EGP',
  period TEXT NOT NULL,
  paid_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'void')),
  method TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (net_amount = amount - commission_amount)
);
CREATE INDEX IF NOT EXISTS admin_settlements_company_date_idx
  ON public.admin_settlements (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_settlements_status_date_idx
  ON public.admin_settlements (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx
  ON public.admin_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_entity_idx
  ON public.admin_audit_logs (entity_type, entity_id, created_at DESC);

-- Idempotent so a newly provisioned company can be upgraded on first admin API use.
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
