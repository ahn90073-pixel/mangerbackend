import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { createAdminToken } from '../lib/adminToken.js';
import { FirebaseConfigurationError, FirebaseServiceError, parseFirebaseAdminEmails, verifyFirebaseIdToken } from '../lib/firebaseAuth.js';
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
  // Never log email, password, password_hash, database URL, Firebase ID token, or session token.
  console.warn(JSON.stringify({
    event: 'admin_login_rejected',
    requestId: c.req.header('cf-ray') || c.req.header('x-request-id') || 'unavailable',
    reason,
    ...details,
  }));
}

async function issueSession(c, user) {
  let token;
  try {
    token = await createAdminToken(user, c.env.ADMIN_JWT_SECRET);
  } catch {
    return errorResponse('مصادقة لوحة الإدارة غير مهيأة على الخادم.', 503);
  }
  await createDb(c.env).query(
    'UPDATE public.admin_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1::uuid',
    [user.id],
  );
  return jsonResponse(ok({ token, user: publicUser(user) }, 'تم تسجيل الدخول بنجاح.'));
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
  if (user.role === 'super_admin') {
    logLoginRejection(c, 'super_admin_must_use_firebase');
    return errorResponse('حساب الأدمن العام يسجل الدخول عبر Firebase.', 403);
  }
  if (user.role !== 'employee') {
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

  return issueSession(c, user);
});

auth.post('/firebase-login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const idToken = typeof body?.idToken === 'string' ? body.idToken : '';
  if (!idToken || idToken.length > 12_000) return errorResponse('تعذر التحقق من جلسة Firebase.', 400);

  let allowedEmails;
  let firebaseUser;
  try {
    allowedEmails = parseFirebaseAdminEmails(c.env.FIREBASE_ADMIN_EMAILS);
    if (!allowedEmails.length) throw new FirebaseConfigurationError('No Firebase admin emails are configured.');
    firebaseUser = await verifyFirebaseIdToken(idToken, {
      apiKey: c.env.FIREBASE_WEB_API_KEY,
      projectId: c.env.FIREBASE_PROJECT_ID,
    });
  } catch (error) {
    if (error instanceof FirebaseConfigurationError) {
      logLoginRejection(c, 'firebase_configuration_invalid');
      return errorResponse('إعداد مصادقة Firebase غير مكتمل على الخادم.', 503);
    }
    if (error instanceof FirebaseServiceError) {
      logLoginRejection(c, 'firebase_verification_unavailable');
      return errorResponse('تعذر التحقق من Firebase الآن. حاول مرة أخرى بعد قليل.', 503);
    }
    throw error;
  }

  if (!firebaseUser) {
    logLoginRejection(c, 'firebase_token_invalid');
    return errorResponse('جلسة Firebase غير صالحة أو منتهية. سجّل الدخول مرة أخرى.', 401);
  }
  if (!firebaseUser.emailVerified || firebaseUser.disabled || !firebaseUser.email) {
    logLoginRejection(c, firebaseUser.disabled ? 'firebase_account_disabled' : 'firebase_email_unverified');
    return errorResponse('يجب أن يكون بريد Firebase موثقًا والحساب فعالًا.', 403);
  }
  if (!allowedEmails.includes(firebaseUser.email)) {
    logLoginRejection(c, 'firebase_email_not_allowlisted');
    return errorResponse('هذا البريد غير مصرح له بحساب أدمن عام.', 403);
  }

  const db = createDb(c.env);
  let user;
  try {
    [user] = await db.query(
      `SELECT id, email, full_name, role, assigned_governorates, is_active, token_version
       FROM public.link_firebase_super_admin($1, $2, $3)`,
      [firebaseUser.uid, firebaseUser.email, firebaseUser.displayName],
    );
  } catch (error) {
    if (error?.code === '23514') {
      logLoginRejection(c, 'firebase_admin_link_conflict_or_admin_limit');
      return errorResponse('تعذر ربط هذا الحساب. تحقق من صلاحية البريد أو أن الحد الأقصى ثلاثة أدمن.', 403);
    }
    throw error;
  }
  if (!user || user.role !== 'super_admin' || !user.is_active) {
    logLoginRejection(c, 'firebase_admin_provision_failed');
    return errorResponse('تعذر تفعيل صلاحية الأدمن لهذا الحساب.', 403);
  }

  return issueSession(c, user);
});

auth.get('/me', ...adminGuard, (c) => jsonResponse(ok(c.get('adminUser'))));
auth.post('/logout', ...adminGuard, (c) => jsonResponse(ok({ loggedOut: true })));

export default auth;
