const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY;
const baseUrl = 'https://mangerbackend.ahn90073.workers.dev';

if (!firebaseApiKey) {
  console.error('Missing Firebase API key.');
  process.exit(1);
}

try {
  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(20000) });
  if (!health.ok) {
    console.error(`Deployed Worker health check failed with HTTP ${health.status}.`);
    process.exit(1);
  }

  // Invalid token must be rejected by the live Firebase verification path without issuing a session.
  const response = await fetch(`${baseUrl}/api/admin/auth/google`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: 'ci-invalid-firebase-id-token-'.padEnd(120, 'x') }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => null);
  if (response.status !== 401 || payload?.success !== false) {
    const requestId = response.headers.get('cf-ray') || 'unavailable';
    console.error(`Google auth route check failed with HTTP ${response.status} (Cloudflare request ID: ${requestId}). No response body or secrets were printed.`);
    process.exit(1);
  }
  console.log('Google authentication route is deployed and rejects an invalid Firebase token; no session was issued.');
} catch (error) {
  const safeName = typeof error?.name === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(error.name)
    ? error.name
    : 'unknown error';
  console.error(`Google login diagnosis failed (${safeName}). Credentials and response body were not printed.`);
  process.exit(1);
}
