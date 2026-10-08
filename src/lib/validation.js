import { errorResponse } from './response.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
export const isText = (value, max = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export const isMoney = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;

export async function readJson(c) {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: errorResponse('A JSON object body is required.', 400) };
  }
  return { body };
}

export function pagination(c, defaultLimit = 20, maxLimit = 100) {
  const pageValue = Number.parseInt(c.req.query('page') || '1', 10);
  const limitValue = Number.parseInt(c.req.query('limit') || String(defaultLimit), 10);
  const page = Number.isFinite(pageValue) ? Math.max(1, pageValue) : 1;
  const limit = Number.isFinite(limitValue) ? Math.min(maxLimit, Math.max(1, limitValue)) : defaultLimit;
  return { page, limit, offset: (page - 1) * limit };
}

export function paginated(items, total, page, limit) {
  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export function searchTerm(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
