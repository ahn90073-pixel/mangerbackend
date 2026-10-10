import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { createAdminToken } from '../lib/adminToken.js';
import { verifyPassword } from '../lib/password.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { adminGuard } from '../middleware/adminAuth.js';

const auth = new Hono();

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name ?? user.fullName,
    role: user.role,
    assignedGovernorates: user.assigned_governorates ?? user.assignedGovernorates ?? [],
  };
}

auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !password || password.length > 1024) {
    return errorResponse('أدخل بريدًا إلكترونيًا وكلمة مرور صالحين.', 400);
  }

  const db = createDb(c.env);
  const [user] = await db.query(
    `SELECT id, email, full_name, password_hash, role, assigned_governorates, is_active, token_version
     FROM public.admin_users WHERE LOWER(email) = $1 LIMIT 1`,
    [email],
  );
  if (!user || !user.is_active || !['super_admin', 'employee'].includes(user.role)) {
    return errorResponse('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 401);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    return errorResponse('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 401);
  }

  let token;
  try {
    token = await createAdminToken(user, c.env.ADMIN_JWT_SECRET);
  } catch {
    return errorResponse('مصادقة لوحة الإدارة غير مهيأة على الخادم.', 503);
  }
  await db.query('UPDATE public.admin_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1::uuid', [user.id]);
  return jsonResponse(ok({ token, user: publicUser(user) }, 'تم تسجيل الدخول بنجاح.'));
});

auth.get('/me', ...adminGuard, (c) => jsonResponse(ok(c.get('adminUser'))));
auth.post('/logout', ...adminGuard, (c) => jsonResponse(ok({ loggedOut: true })));

export default auth;
