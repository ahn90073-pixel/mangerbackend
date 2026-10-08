import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { sign } from 'hono/utils/jwt/jwt';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { readJson, isText } from '../lib/validation.js';
import { adminGuard } from '../middleware/adminAuth.js';
import { writeAudit } from '../lib/audit.js';

const auth = new Hono();

function validEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

auth.post('/login', async (c) => {
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const { email, password } = parsed.body;
  if (!validEmail(email) || !isText(password, 256)) {
    return errorResponse('A valid email and password are required.', 400);
  }
  if (!c.env.JWT_SECRET) return errorResponse('Authentication service is not configured.', 503);

  const db = createDb(c.env);
  const [user] = await db`
    SELECT id, email, full_name, phone, password_hash, is_platform_admin
    FROM public.users WHERE LOWER(email) = ${email.trim().toLowerCase()} LIMIT 1
  `;
  const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!user || !passwordMatches) return errorResponse('Invalid email or password.', 401);
  if (!user.is_platform_admin) return errorResponse('This account is not a platform administrator.', 403);

  const now = Math.floor(Date.now() / 1000);
  const token = await sign({
    sub: user.id,
    email: user.email,
    is_platform_admin: true,
    iat: now,
    exp: now + 60 * 60 * 12,
  }, c.env.JWT_SECRET, 'HS256');
  await writeAudit(db, c, user.id, 'admin.login', 'user', user.id, {});
  return jsonResponse(ok({
    token,
    expiresIn: 60 * 60 * 12,
    user: { id: user.id, email: user.email, fullName: user.full_name, phone: user.phone, isPlatformAdmin: true },
  }, 'Login successful'));
});

auth.get('/me', ...adminGuard, async (c) => {
  const user = c.get('adminUser');
  return jsonResponse(ok({
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    phone: user.phone,
    isPlatformAdmin: true,
  }));
});

export default auth;
