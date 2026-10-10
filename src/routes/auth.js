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

function logLoginRejection(c, reason, details = {}) {
  // Never log email, password, password_hash, database URL, or session token.
  console.warn(JSON.stringify({
    event: 'admin_login_rejected',
    requestId: c.req.header('cf-ray') || c.req.header('x-request-id') || 'unavailable',
    reason,
    ...details,
  }));
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
  if (!user) {
    logLoginRejection(c, 'account_not_found_or_email_mismatch');
    return errorResponse('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 401);
  }
  if (!user.is_active) {
    logLoginRejection(c, 'account_inactive', { role: user.role });
    return errorResponse('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 401);
  }
  if (!['super_admin', 'employee'].includes(user.role)) {
    logLoginRejection(c, 'role_not_allowed', { role: user.role });
    return errorResponse('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 401);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    const hashParts = typeof user.password_hash === 'string' ? user.password_hash.split('$') : [];
    const parsedIterations = Number(hashParts[1]);
    logLoginRejection(c, 'password_hash_mismatch', {
      role: user.role,
      hashAlgorithm: hashParts[0] || 'missing_or_malformed',
      hashIterations: Number.isInteger(parsedIterations) ? parsedIterations : null,
    });
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
