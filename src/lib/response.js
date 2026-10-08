export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function ok(data = null, message = 'Success') {
  return { success: true, message, data };
}

export function errorResponse(message, status = 500, errors = undefined) {
  const body = { success: false, message };
  if (errors !== undefined) body.errors = errors;
  return jsonResponse(body, status);
}

export function readError(error) {
  if (error?.status && error.status < 500) return errorResponse(error.message, error.status);
  console.error('Admin API error:', error?.code || error?.name || 'unknown');
  return errorResponse(error?.status === 503 ? error.message : 'Internal server error', error?.status || 500);
}
