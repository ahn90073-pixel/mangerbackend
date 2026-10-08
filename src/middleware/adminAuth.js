// This deployment is intentionally public at the user's explicit request.
// Keep a null actor for write/audit paths; do not treat CORS as authentication.
export async function publicAdminContext(c, next) {
  c.set('identity', null);
  c.set('adminUser', { id: null, email: null, full_name: null, is_platform_admin: false });
  await next();
}

export const adminGuard = [publicAdminContext];
