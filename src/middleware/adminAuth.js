import { createDb } from '../lib/db.js';
import { verifyAdminToken } from '../lib/adminToken.js';
import { errorResponse } from '../lib/response.js';

export async function authenticateAdmin(c, next) {
  const authorization = c.req.header('Authorization') || '';
  const match = authorization.match(/^Bearer\s+([A-Za-z0-9._-]+)$/i);
  if (!match) return errorResponse('يلزم تسجيل الدخول للوصول إلى لوحة الإدارة.', 401);

  let claims;
  try {
    claims = await verifyAdminToken(match[1], c.env.ADMIN_JWT_SECRET);
  } catch {
    return errorResponse('مصادقة لوحة الإدارة غير مهيأة.', 503);
  }
  if (!claims) return errorResponse('جلسة الدخول غير صالحة أو منتهية. سجّل الدخول مجددًا.', 401);

  const db = createDb(c.env);
  const [row] = await db.query(
    `SELECT id, email, full_name, role, assigned_governorates, is_active, token_version
     FROM public.admin_users WHERE id = $1::uuid LIMIT 1`,
    [claims.sub],
  );
  if (!row || !row.is_active || Number(row.token_version) !== claims.ver) {
    return errorResponse('الحساب غير نشط أو انتهت صلاحيته. سجّل الدخول مجددًا.', 401);
  }
  if (!['super_admin', 'employee'].includes(row.role)) return errorResponse('الدور غير مخوّل للوصول إلى لوحة الإدارة.', 403);

  const user = {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    assignedGovernorates: Array.isArray(row.assigned_governorates) ? row.assigned_governorates : [],
    isActive: Boolean(row.is_active),
    tokenVersion: Number(row.token_version),
  };
  c.set('adminUser', user);
  c.set('identity', { id: user.id, email: user.email, role: user.role });
  await next();
}

export async function requireSuperAdmin(c, next) {
  if (c.get('adminUser')?.role !== 'super_admin') {
    return errorResponse('هذه العملية متاحة للأدمن العام فقط.', 403);
  }
  await next();
}

export const adminGuard = [authenticateAdmin];
export const superAdminGuard = [authenticateAdmin, requireSuperAdmin];
