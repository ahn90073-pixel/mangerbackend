import { verify } from 'hono/utils/jwt/jwt';
import { createDb } from '../lib/db.js';
import { errorResponse } from '../lib/response.js';

export async function adminToken(c, next) {
  const header = c.req.header('Authorization') || '';
  if (!header.startsWith('Bearer ')) return errorResponse('Authentication token is required.', 401);
  const token = header.slice(7).trim();
  if (!token) return errorResponse('Authentication token is required.', 401);
  try {
    const payload = await verify(token, c.env.JWT_SECRET, 'HS256');
    if (!payload?.sub) return errorResponse('Invalid or expired token.', 401);
    c.set('identity', { id: payload.sub, email: payload.email || null });
  } catch (error) {
    if (error?.code === 'JWT_SECRET_MISSING' || !c.env.JWT_SECRET) {
      return errorResponse('Authentication service is not configured.', 503);
    }
    return errorResponse('Invalid or expired token.', 401);
  }
  await next();
}

export async function requirePlatformAdmin(c, next) {
  const identity = c.get('identity');
  if (!identity?.id) return errorResponse('Authentication is required.', 401);
  const db = createDb(c.env);
  const [user] = await db`
    SELECT id, email, full_name, phone, is_platform_admin
    FROM public.users WHERE id = ${identity.id} LIMIT 1
  `;
  if (!user) return errorResponse('User account was not found.', 401);
  if (!user.is_platform_admin) return errorResponse('Platform administrator access is required.', 403);
  c.set('adminUser', user);
  await next();
}

export const adminGuard = [adminToken, requirePlatformAdmin];
