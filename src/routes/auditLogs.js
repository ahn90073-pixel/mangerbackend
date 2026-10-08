import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { adminGuard } from '../middleware/adminAuth.js';
import { pagination, paginated, searchTerm } from '../lib/validation.js';

const auditLogs = new Hono();

auditLogs.get('/', ...adminGuard, async (c) => {
  const { page, limit, offset } = pagination(c, 50, 100);
  const entityType = searchTerm(c.req.query('entityType'), 80);
  const action = searchTerm(c.req.query('action'), 120);
  const q = searchTerm(c.req.query('q'));
  const values = [];
  const filters = [];
  if (entityType) { values.push(entityType); filters.push(`l.entity_type = $${values.length}`); }
  if (action) { values.push(`%${action}%`); filters.push(`l.action ILIKE $${values.length}`); }
  if (q) {
    values.push(`%${q}%`);
    const p = `$${values.length}`;
    filters.push(`(l.entity_id ILIKE ${p} OR l.details::text ILIKE ${p} OR u.email ILIKE ${p})`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  values.push(limit, offset);
  const rows = await createDb(c.env).query(
    `SELECT l.id, l.actor_user_id AS "actorUserId", u.email AS "actorEmail",
      l.action, l.entity_type AS "entityType", l.entity_id AS "entityId",
      l.details, l.ip_address AS "ipAddress", l.created_at AS "createdAt",
      count(*) OVER()::int AS _total
     FROM public.admin_audit_logs l LEFT JOIN public.users u ON u.id = l.actor_user_id
     ${where} ORDER BY l.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = rows.length ? rows[0]._total : 0;
  return jsonResponse(ok(paginated(rows.map(({ _total, ...row }) => row), total, page, limit)));
});

export default auditLogs;
