export async function writeAudit(db, c, actorId, action, entityType, entityId, details = {}) {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  const userAgent = (c.req.header('User-Agent') || '').slice(0, 500) || null;
  await db`
    INSERT INTO public.admin_audit_logs
      (actor_user_id, action, entity_type, entity_id, details, ip_address, user_agent)
    VALUES
      (${actorId}, ${action}, ${entityType}, ${String(entityId).slice(0, 200)}, ${JSON.stringify(details)}::jsonb, ${ip}, ${userAgent})
  `;
}
