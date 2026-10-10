const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() ?? '';
const password = process.env.INITIAL_ADMIN_PASSWORD ?? '';
const loginUrl = 'https://mangerbackend.ahn90073.workers.dev/api/admin/auth/login';

if (!email || !password) {
  console.error('Missing INITIAL_ADMIN_EMAIL or INITIAL_ADMIN_PASSWORD GitHub Actions secret.');
  process.exit(1);
}

try {
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => null);
  const data = payload?.data ?? payload;
  if (!response.ok || payload?.success === false || !data?.token || !data?.user?.role) {
    console.error(`Login check failed with HTTP ${response.status}. Response details and credentials were not printed.`);
    process.exit(1);
  }
  console.log(`Login check passed. Authenticated role: ${data.user.role}. Token was discarded and not logged.`);
} catch (error) {
  const safeName = typeof error?.name === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(error.name)
    ? error.name
    : 'unknown error';
  console.error(`Login check could not reach the admin API (${safeName}). No credentials were printed.`);
  process.exit(1);
}
