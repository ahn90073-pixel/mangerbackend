import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { isUuid } from '../lib/validation.js';
import { superAdminGuard } from '../middleware/adminAuth.js';

const promotions = new Hono();
const MAX_TEXT = {
  title: 160,
  subtitle: 240,
  description: 2000,
  ctaLabel: 80,
  targetUrl: 2048,
  theme: 40,
};
const FIELD_COLUMNS = {
  title: ['title', 'text'],
  subtitle: ['subtitle', 'text'],
  description: ['description', 'text'],
  ctaLabel: ['cta_label', 'text'],
  targetUrl: ['target_url', 'text'],
  theme: ['theme', 'text'],
  isActive: ['is_active', 'boolean'],
  sortOrder: ['sort_order', 'integer'],
  startsAt: ['starts_at', 'timestamptz'],
  endsAt: ['ends_at', 'timestamptz'],
};
const FIELD_NAMES = Object.keys(FIELD_COLUMNS);
const MEDIA_FIELDS = ['mediaUrl', 'mediaKey', 'mediaType'];
const PROMOTION_THEMES = new Set(['blue', 'orange', 'slate', 'violet']);

function mapPromotion(row) {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle ?? '',
    description: row.description ?? '',
    ctaLabel: row.ctaLabel ?? row.cta_label ?? '',
    targetUrl: row.targetUrl ?? row.target_url ?? null,
    mediaUrl: row.mediaUrl ?? row.media_url ?? null,
    mediaKey: row.mediaKey ?? row.media_key ?? null,
    mediaType: row.mediaType ?? row.media_type ?? null,
    theme: row.theme,
    isActive: Boolean(row.isActive ?? row.is_active),
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
    startsAt: row.startsAt ?? row.starts_at ?? null,
    endsAt: row.endsAt ?? row.ends_at ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
  };
}

function validText(value, field, required = false) {
  if (value === undefined) return required ? `${field} is required.` : null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEXT[field]) {
    return `${field} must be a non-empty string of at most ${MAX_TEXT[field]} characters.`;
  }
  return null;
}

function validNullableText(value, field) {
  if (value === undefined) return null;
  if (value !== null && (typeof value !== 'string' || value.length > MAX_TEXT[field])) {
    return `${field} must be a string of at most ${MAX_TEXT[field]} characters.`;
  }
  return null;
}

function validTargetUrl(value, required = false) {
  if (value === undefined) return required ? 'targetUrl is required.' : null;
  if (typeof value !== 'string' || value.length > MAX_TEXT.targetUrl || /[\u0000-\u0020]/.test(value)) {
    return 'targetUrl must be an internal path or an HTTPS URL.';
  }
  if (value.length === 0) return required ? 'targetUrl is required.' : null;
  if (value.startsWith('/') && !value.startsWith('//')) return null;
  if (!/^https:\/\/[^\s]+$/i.test(value)) return 'targetUrl must be an internal path or an HTTPS URL.';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return 'targetUrl must be an internal path or an HTTPS URL.';
  } catch {
    return 'targetUrl must be an internal path or an HTTPS URL.';
  }
  return null;
}

function validDate(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 80 || Number.isNaN(Date.parse(value))) return `${field} must be a valid date.`;
  return null;
}

function cloudinaryMediaKind(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') return null;
    const match = parsed.pathname.match(/\/(image|video)\/upload\//);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function validateMedia(input, errors, values, { partial }) {
  const supplied = MEDIA_FIELDS.filter((field) => input[field] !== undefined);
  if (partial && supplied.length > 0 && supplied.length < MEDIA_FIELDS.length) {
    errors.push('mediaUrl, mediaKey, and mediaType must be provided together.');
    return;
  }
  if (!partial) {
    for (const field of MEDIA_FIELDS) {
      if (input[field] === undefined) errors.push(`${field} is required.`);
    }
  }
  if (supplied.length === 0) return;

  const mediaKind = cloudinaryMediaKind(input.mediaUrl);
  if (!mediaKind) {
    errors.push('mediaUrl must be an HTTPS Cloudinary URL on res.cloudinary.com containing /image/upload/ or /video/upload/.');
  }
  if (!isUuid(input.mediaKey)) {
    errors.push('mediaKey must be a UUID.');
  }
  if (input.mediaType !== 'image' && input.mediaType !== 'video') {
    errors.push('mediaType must be image or video.');
  } else if (mediaKind && input.mediaType !== mediaKind) {
    errors.push('mediaType must match the mediaUrl resource type.');
  }
  if (errors.length === 0 || !errors.some((error) => error.startsWith('media'))) {
    values.mediaUrl = input.mediaUrl;
    values.mediaKey = input.mediaKey;
    values.mediaType = input.mediaType;
  }
}

function validatePromotion(input, { partial = false, existing = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'promotion must be a JSON object.' };
  const errors = [];
  const values = {};
  const requireField = (field) => !partial && input[field] === undefined;

  const titleError = validText(input.title, 'title', requireField('title'));
  if (titleError) errors.push(titleError); else if (input.title !== undefined) values.title = input.title.trim();
  for (const field of ['subtitle', 'description', 'ctaLabel']) {
    const error = validNullableText(input[field], field);
    if (error) errors.push(error); else if (input[field] !== undefined) values[field] = input[field] === null ? null : input[field].trim();
  }
  const targetError = validTargetUrl(input.targetUrl);
  if (targetError) errors.push(targetError);
  else if (input.targetUrl !== undefined) values.targetUrl = input.targetUrl.trim() || '/';
  else if (!partial) values.targetUrl = '/';

  if (input.theme !== undefined) {
    if (typeof input.theme !== 'string' || !PROMOTION_THEMES.has(input.theme)) errors.push('theme must be one of blue, orange, slate, or violet.');
    else values.theme = input.theme;
  } else if (!partial) values.theme = 'blue';
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== 'boolean') errors.push('isActive must be a boolean.'); else values.isActive = input.isActive;
  } else if (!partial) values.isActive = true;
  if (input.sortOrder !== undefined) {
    if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 1_000_000) errors.push('sortOrder must be an integer from 0 to 1000000.');
    else values.sortOrder = input.sortOrder;
  } else if (!partial) values.sortOrder = 0;
  for (const field of ['startsAt', 'endsAt']) {
    const error = validDate(input[field], field);
    if (error) errors.push(error); else if (input[field] !== undefined) values[field] = input[field] === '' ? null : input[field];
  }

  validateMedia(input, errors, values, { partial });
  const startsAt = values.startsAt !== undefined ? values.startsAt : existing?.startsAt ?? existing?.starts_at;
  const endsAt = values.endsAt !== undefined ? values.endsAt : existing?.endsAt ?? existing?.ends_at;
  if (startsAt && endsAt && new Date(startsAt).getTime() > new Date(endsAt).getTime()) errors.push('startsAt must be earlier than or equal to endsAt.');
  return errors.length ? { errors } : { values };
}

async function readPromotionJson(c) {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return { error: errorResponse('A valid JSON object body is required.', 400) };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: errorResponse('A JSON object body is required.', 400) };
  }
  return { body };
}

const selectColumns = `
  id, title, subtitle, description, cta_label AS "ctaLabel", target_url AS "targetUrl",
  media_url AS "mediaUrl", theme, is_active AS "isActive", sort_order AS "sortOrder", starts_at AS "startsAt",
  ends_at AS "endsAt", media_key AS "mediaKey", media_type AS "mediaType",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

promotions.get('/', ...superAdminGuard, async (c) => {
  const rows = await createDb(c.env).query(
    `SELECT ${selectColumns} FROM public.storefront_promotions ORDER BY sort_order ASC, created_at ASC`,
    [],
  );
  return jsonResponse(ok({ items: rows.map(mapPromotion) }));
});

promotions.post('/', ...superAdminGuard, async (c) => {
  const parsed = await readPromotionJson(c);
  if (parsed.error) return parsed.error;
  const checked = validatePromotion(parsed.body);
  if (checked.error) return errorResponse(checked.error, 400);
  if (checked.errors) return errorResponse('Please review the promotion fields.', 400, checked.errors);

  const v = checked.values;
  const [row] = await createDb(c.env).query(
    `INSERT INTO public.storefront_promotions
     (title, subtitle, description, cta_label, target_url, media_url, media_key, media_type, theme, is_active, sort_order, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz)
     RETURNING ${selectColumns}`,
    [v.title, v.subtitle ?? '', v.description ?? '', v.ctaLabel ?? 'تسوق الآن', v.targetUrl, v.mediaUrl, v.mediaKey, v.mediaType, v.theme, v.isActive, v.sortOrder, v.startsAt ?? null, v.endsAt ?? null],
  );
  return jsonResponse(ok(mapPromotion(row), 'Promotion created.'), 201);
});

promotions.patch('/:id', ...superAdminGuard, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return errorResponse('Promotion ID must be a UUID.', 400);
  const parsed = await readPromotionJson(c);
  if (parsed.error) return parsed.error;
  const db = createDb(c.env);
  const [existing] = await db.query(`SELECT ${selectColumns} FROM public.storefront_promotions WHERE id = $1::uuid LIMIT 1`, [id]);
  if (!existing) return errorResponse('Promotion not found.', 404);
  const checked = validatePromotion(parsed.body, { partial: true, existing });
  if (checked.error) return errorResponse(checked.error, 400);
  if (checked.errors) return errorResponse('Please review the promotion fields.', 400, checked.errors);
  if (!Object.keys(checked.values).length) return errorResponse('Provide at least one promotion field.', 400);

  const values = checked.values;
  const params = [id];
  const sets = [];
  for (const field of FIELD_NAMES) {
    if (values[field] === undefined) continue;
    const [column, type] = FIELD_COLUMNS[field];
    params.push(values[field]);
    const placeholder = `$${params.length}`;
    sets.push(`${column} = ${type === 'text' ? placeholder : `${placeholder}::${type}`}`);
  }
  for (const field of MEDIA_FIELDS) {
    if (values[field] === undefined) continue;
    params.push(values[field]);
    sets.push(`${field === 'mediaUrl' ? 'media_url' : field === 'mediaKey' ? 'media_key' : 'media_type'} = $${params.length}`);
  }

  const [row] = await db.query(
    `UPDATE public.storefront_promotions SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $1::uuid RETURNING ${selectColumns}`,
    params,
  );
  return jsonResponse(ok(mapPromotion(row), 'Promotion updated.'));
});

promotions.delete('/:id', ...superAdminGuard, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return errorResponse('Promotion ID must be a UUID.', 400);
  const [deleted] = await createDb(c.env).query(
    `DELETE FROM public.storefront_promotions WHERE id = $1::uuid RETURNING ${selectColumns}`,
    [id],
  );
  if (!deleted) return errorResponse('Promotion not found.', 404);
  return jsonResponse(ok(mapPromotion(deleted), 'Promotion deleted.'));
});

export { mapPromotion, validatePromotion };
export default promotions;
