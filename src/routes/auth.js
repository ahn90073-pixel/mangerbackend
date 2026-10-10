import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { createAdminToken } from '../lib/adminToken.js';
import { verifyPassword } from '../lib/password.js';
import { lookupFirebaseGoogleUser } from '../lib/firebaseAuth.js';
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
  // Never log email, password, password_hash, database URL, ID token, or session token.
  console.warn(JSON.stringify({
    event: 'admin_login_rejected',
    requestId: c.req.header('cf-ray') || c.req.header('x-request-id') || 'unavailable',
    reason,
    ...details,
  }));
}

async function getAdminByEmail(db, email) {
  const [user] = await db.query(
    `SELECT id, email, full_name, password_hash, role, assigned_governorates, is_active,
            token_version, firebase_uid, auth_provider
     FROM public.admin_users WHERE LOWER(email) = $1 LIMIT 1`,
    [email],
  );
  return user || null;
}

export async function reserveGoogleAdminSlot(db, email) {
  // Seats are permanent: the first three verified Google identities claim them; later signups stay closed.
  const [existing] = await db.query(
    'SELECT slot FROM public.admin_google_admin_slots WHERE email = $1 LIMIT 1',
    [email],
  );
  if (existing) return true;

  try {
    const [reserved] = await db.query(
      `UPDATE public.admin_google_admin_slots
       SET email = $1, reserved_at = NOW()
       WHERE slot = (
         SELECT slot FROM public.admin_google_admin_slots
         WHERE email IS NULL ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1
       ) AND email IS NULL
       RETURNING slot`,
      [email],
    );
    if (reserved) return true;
  } catch (error) {
    // A concurrent login for the same Gmail may have claimed the unique email first.
    if (error?.code !== '23505') throw error;
  }
  const [concurrentReservation] = await db.query(
    'SELECT slot FROM public.admin_google_admin_slots WHERE email = $1 LIMIT 1',
    [email],
  );
  return Boolean(concurrentReservation);
}

async function createGoogleAdminIfMissing(db, email, fullName, firebaseUid) {
  let user = await getAdminByEmail(db, email);
  if (user && user.role !== 'super_admin') return { error: 'هذا البريد مرتبط بحساب موظف. استخدم بيانات دخول الموظف.' };
  if (user && !user.is_active) return { error: 'حساب الأدمن غير نشط. تواصل مع مسؤول النظام.' };
  if (user?.firebase_uid && user.firebase_uid !== firebaseUid) return { error: 'حساب Google لا يطابق هوية Firebase المرتبطة بهذا البريد.' };
  const [uidOwner] = await db.query(
    'SELECT id FROM public.admin_users WHERE firebase_uid = $1 AND LOWER(email) <> $2 LIMIT 1',
    [firebaseUid, email],
  );
  if (uidOwner) return { error: 'هوية Firebase مرتبطة بحساب إدارة آخر.' };
  if (!(await reserveGoogleAdminSlot(db, email))) return { limitReached: true };

  if (!user) {
    try {
      const [created] = await db.query(
        `INSERT INTO public.admin_users
           (email, full_name, password_hash, role, assigned_governorates, firebase_uid, auth_provider)
         VALUES ($1, $2, NULL, 'super_admin', ARRAY[]::TEXT[], $3, 'firebase')
         RETURNING id, email, full_name, password_hash, role, assigned_governorates,
                   is_active, token_version, firebase_uid, auth_provider`,
        [email, fullName || email, firebaseUid],
      );
      user = created;
    } catch (error) {
      if (error?.code !== '23505') throw error;
      // A simultaneous login may have created this same account after our initial lookup.
      user = await getAdminByEmail(db, email);
      if (!user || user.role !== 'super_admin') return { error: 'تعذر ربط حساب Google بحساب الإدارة.' };
    }
  }

  const [updated] = await db.query(
    `UPDATE public.admin_users
     SET firebase_uid = $2, auth_provider = 'firebase', full_name = COALESCE(NULLIF(full_name, ''), $3),
         last_login_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid
     RETURNING id, email, full_name, password_hash, role, assigned_governorates,
               is_active, token_version, firebase_uid, auth_provider`,
    [user.id, firebaseUid, fullName || email],
  );
  return { user: updated };
}

auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !password || password.length > 1024) {
    return errorResponse('أدخل بريدًا إلكترونيًا وكلمة مرور صالحين.', 400);
  }

  const db = createDb(c.env);
  const user = await getAdminByEmail(db, email);
  if (!user) {
    logLoginRejection(c, 'account_not_found_or_email_mismatch');
    return errorResponse('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 401);
  }
  if (user.role === 'super_admin') {
    return errorResponse('يجب على الأدمن تسجيل الدخول باستخدام حساب Google المعتمد.', 403);
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

auth.post('/google', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.idToken !== 'string' || body.idToken.length > 12000) {
    return errorResponse('بيانات تسجيل Google غير صالحة.', 400);
  }

  if (!c.env.FIREBASE_WEB_API_KEY) {
    return errorResponse('مصادقة Google للأدمن غير مهيأة على الخادم.', 503);
  }

  let identity;
  try {
    identity = await lookupFirebaseGoogleUser(body.idToken, c.env.FIREBASE_WEB_API_KEY);
  } catch {
    return errorResponse('تعذر التحقق من حساب Google الآن. حاول مرة أخرى.', 503);
  }
  if (!identity) return errorResponse('تعذر التحقق من حساب Google أو أن البريد غير مؤكّد.', 401);
  const db = createDb(c.env);
  const result = await createGoogleAdminIfMissing(db, identity.email, identity.fullName, identity.uid);
  if (result.error) return errorResponse(result.error, 403);
  if (result.limitReached) {
    return errorResponse('اكتمل العدد المسموح به وهو ثلاثة حسابات أدمن؛ تم إغلاق التسجيل الإداري.', 403);
  }

  let token;
  try {
    token = await createAdminToken(result.user, c.env.ADMIN_JWT_SECRET);
  } catch {
    return errorResponse('مصادقة لوحة الإدارة غير مهيأة على الخادم.', 503);
  }
  return jsonResponse(ok({ token, user: publicUser(result.user) }, 'تم تسجيل الدخول بنجاح.'));
});

auth.get('/me', ...adminGuard, (c) => jsonResponse(ok(c.get('adminUser'))));
auth.post('/logout', ...adminGuard, (c) => jsonResponse(ok({ loggedOut: true })));

export default auth;
