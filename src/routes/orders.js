import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { adminGuard } from '../middleware/adminAuth.js';
import { listAdminOrders } from '../services/orderService.js';
import { pagination, searchTerm, isUuid } from '../lib/validation.js';

const orders = new Hono();
const orderStatuses = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'returned', 'refunded']);

orders.get('/', ...adminGuard, async (c) => {
  const status = c.req.query('status') || 'all';
  if (status !== 'all' && !orderStatuses.has(status)) return errorResponse('Unsupported order status.', 400);
  const companyId = c.req.query('vendorId') || null;
  if (companyId && !isUuid(companyId)) return errorResponse('vendorId must be a UUID.', 400);
  const { page, limit, offset } = pagination(c, 20, 100);
  const data = await listAdminOrders(createDb(c.env), {
    page, limit, offset, status, companyId, q: searchTerm(c.req.query('q')),
  });
  return jsonResponse(ok(data));
});

export default orders;
