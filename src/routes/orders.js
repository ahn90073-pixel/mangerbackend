import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { adminGuard } from '../middleware/adminAuth.js';
import { listAdminOrders } from '../services/orderService.js';
import { pagination, searchTerm, isUuid, isMoney, readJson } from '../lib/validation.js';
import { tenantTable } from '../lib/tenant.js';
import { writeAudit } from '../lib/audit.js';
import { assignedGovernorates } from '../lib/access.js';

const orders = new Hono();
const orderStatuses = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'returned', 'refunded']);
const shipmentStatuses = new Set(['pending', 'label_created', 'picked_up', 'in_transit', 'delivered', 'failed', 'returned']);
const transitions = {
  pending: new Set(['pending', 'confirmed', 'processing', 'cancelled']),
  confirmed: new Set(['confirmed', 'processing', 'shipped', 'delivered', 'cancelled']),
  processing: new Set(['processing', 'confirmed', 'shipped', 'delivered', 'cancelled']),
  shipped: new Set(['shipped', 'delivered', 'returned']),
  delivered: new Set(['delivered', 'returned', 'refunded']),
  cancelled: new Set(['cancelled']),
  returned: new Set(['returned', 'refunded']),
  refunded: new Set(['refunded']),
};

export function validateOrderUpdate(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['بيانات التحديث غير صالحة.'];
  if (body.status !== undefined && !orderStatuses.has(body.status)) errors.push('حالة الطلب غير مدعومة.');
  if (body.shipmentStatus !== undefined && !shipmentStatuses.has(body.shipmentStatus)) errors.push('حالة الشحنة غير مدعومة.');
  if (body.carrier !== undefined && (typeof body.carrier !== 'string' || body.carrier.length > 120)) errors.push('اسم شركة الشحن غير صالح.');
  if (body.trackingNumber !== undefined && (typeof body.trackingNumber !== 'string' || body.trackingNumber.length > 160)) errors.push('رقم التتبع غير صالح.');
  if (body.shippingFee !== undefined && !isMoney(body.shippingFee)) errors.push('رسوم الشحن يجب أن تكون مبلغًا غير سالب.');
  if (!['status', 'shipmentStatus', 'carrier', 'trackingNumber', 'shippingFee'].some((key) => body[key] !== undefined)) {
    errors.push('لم يتم تحديد أي حقل للتحديث.');
  }
  return errors;
}

async function loadCompany(db, vendorId, governorates = null) {
  const rows = await db.query(
    `SELECT c.id, c.display_name, c.tenant_schema_name, c.governorate,
      COALESCE(c.email, merchant.email) AS contact_email,
      merchant.full_name AS merchant_name,
      merchant.phone AS contact_phone
    FROM public.companies c
    LEFT JOIN LATERAL (
      SELECT u.full_name, u.email, u.phone
      FROM public.company_members cm
      JOIN public.users u ON u.id = cm.user_id
      WHERE cm.company_id = c.id AND cm.is_active = TRUE
      ORDER BY (cm.role = 'owner') DESC, cm.created_at ASC
      LIMIT 1
    ) merchant ON TRUE
    WHERE c.id = $1::uuid
      AND ($2::text[] IS NULL OR c.governorate = ANY($2::text[]))
    LIMIT 1`,
    [vendorId, governorates],
  );
  return rows[0] || null;
}

async function loadOrderDetails(db, vendorId, orderId, governorates = null) {
  const company = await loadCompany(db, vendorId, governorates);
  if (!company) return null;
  const orderTable = tenantTable(company.tenant_schema_name, 'orders');
  const itemTable = tenantTable(company.tenant_schema_name, 'order_items');
  const customerTable = tenantTable(company.tenant_schema_name, 'customers');
  const addressTable = tenantTable(company.tenant_schema_name, 'addresses');
  const shipmentTable = tenantTable(company.tenant_schema_name, 'shipments');
  const [row] = await db.query(
    `SELECT o.id, o.order_number, o.company_id, o.customer_id, o.address_id,
      o.status, o.payment_method, o.payment_status, o.currency::text AS currency,
      o.subtotal::numeric AS subtotal, o.discount_total::numeric AS discount_total,
      o.shipping_total::numeric AS shipping_total, o.tax_total::numeric AS tax_total,
      o.grand_total::numeric AS grand_total, o.customer_note, o.internal_note,
      o.placed_at, o.created_at,
      c.display_name AS vendor_name, $2::text AS vendor_id,
      $3::text AS merchant_name, $4::text AS vendor_email, $5::text AS vendor_phone,
      COALESCE(a.recipient_name, cu.full_name, 'زائر') AS customer_name,
      COALESCE(NULLIF(cu.metadata->>'contactEmail', ''), cu.email, '') AS customer_email,
      COALESCE(a.phone, cu.phone, '') AS customer_phone,
      a.country, a.governorate, a.city, a.district, a.street, a.building,
      a.apartment, a.postal_code, a.notes AS address_notes,
      s.carrier, s.tracking_number, s.status AS shipment_status,
      s.shipping_address, s.shipped_at, s.delivered_at
     FROM ${orderTable} o
     JOIN public.companies c ON c.id = o.company_id
     LEFT JOIN ${customerTable} cu ON cu.id = o.customer_id
     LEFT JOIN ${addressTable} a ON a.id = o.address_id
     LEFT JOIN ${shipmentTable} s ON s.order_id = o.id
     WHERE o.id = $1::uuid AND o.company_id = $2::uuid
     LIMIT 1`,
    [orderId, vendorId, company.merchant_name || '', company.contact_email || '', company.contact_phone || ''],
  );
  if (!row) return null;
  const itemRows = await db.query(
    `SELECT id, product_id, product_name, sku, quantity,
      unit_price::numeric AS unit_price, total_price::numeric AS total_price,
      product_snapshot
     FROM ${itemTable} WHERE order_id = $1::uuid ORDER BY id`,
    [orderId],
  );

  return {
    id: row.order_number,
    orderId: row.id,
    vendorId: row.vendor_id,
    vendor: {
      id: row.vendor_id,
      name: row.vendor_name,
      merchantName: row.merchant_name,
      email: row.vendor_email,
      phone: row.vendor_phone,
    },
    customer: { name: row.customer_name, email: row.customer_email, phone: row.customer_phone },
    address: {
      country: row.country || row.shipping_address?.country || 'Egypt',
      governorate: row.governorate || row.shipping_address?.governorate || '',
      city: row.city || row.shipping_address?.city || '',
      district: row.district || row.shipping_address?.district || '',
      street: row.street || row.shipping_address?.street || '',
      building: row.building || row.shipping_address?.building || '',
      apartment: row.apartment || row.shipping_address?.apartment || '',
      postalCode: row.postal_code || row.shipping_address?.postalCode || '',
      notes: row.address_notes || row.shipping_address?.notes || '',
    },
    items: itemRows.map((item) => ({
      id: item.id,
      productId: item.product_id,
      name: item.product_name,
      sku: item.sku || '',
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      totalPrice: Number(item.total_price),
      imageUrl: item.product_snapshot?.imageUrl || '',
    })),
    totals: {
      currency: row.currency?.trim() || 'EGP',
      subtotal: Number(row.subtotal || 0),
      discount: Number(row.discount_total || 0),
      shipping: Number(row.shipping_total || 0),
      tax: Number(row.tax_total || 0),
      grandTotal: Number(row.grand_total || 0),
    },
    status: row.status,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    customerNote: row.customer_note || '',
    internalNote: row.internal_note || '',
    shipment: {
      carrier: row.carrier || '',
      trackingNumber: row.tracking_number || '',
      status: row.shipment_status || 'pending',
      shippedAt: row.shipped_at,
      deliveredAt: row.delivered_at,
    },
    date: row.placed_at || row.created_at,
  };
}

orders.get('/', ...adminGuard, async (c) => {
  const status = c.req.query('status') || 'all';
  if (status !== 'all' && !orderStatuses.has(status)) return errorResponse('Unsupported order status.', 400);
  const companyId = c.req.query('vendorId') || null;
  if (companyId && !isUuid(companyId)) return errorResponse('vendorId must be a UUID.', 400);
  const { page, limit, offset } = pagination(c, 20, 100);
  const data = await listAdminOrders(createDb(c.env), {
    page, limit, offset, status, companyId, q: searchTerm(c.req.query('q')),
    governorates: assignedGovernorates(c.get('adminUser')),
  });
  return jsonResponse(ok(data));
});

orders.get('/:vendorId/:orderId', ...adminGuard, async (c) => {
  const vendorId = c.req.param('vendorId');
  const orderId = c.req.param('orderId');
  if (!isUuid(vendorId) || !isUuid(orderId)) return errorResponse('Vendor or order ID must be a UUID.', 400);
  const data = await loadOrderDetails(createDb(c.env), vendorId, orderId, assignedGovernorates(c.get('adminUser')));
  if (!data) return errorResponse('Order not found.', 404);
  return jsonResponse(ok(data));
});

orders.patch('/:vendorId/:orderId', ...adminGuard, async (c) => {
  const vendorId = c.req.param('vendorId');
  const orderId = c.req.param('orderId');
  if (!isUuid(vendorId) || !isUuid(orderId)) return errorResponse('Vendor or order ID must be a UUID.', 400);
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const errors = validateOrderUpdate(parsed.body);
  if (errors.length) return errorResponse('يرجى مراجعة بيانات تحديث الطلب.', 400, errors);

  const db = createDb(c.env);
  const governorates = assignedGovernorates(c.get('adminUser'));
  const company = await loadCompany(db, vendorId, governorates);
  if (!company) return errorResponse('Vendor not found.', 404);
  const orderTable = tenantTable(company.tenant_schema_name, 'orders');
  const productTable = tenantTable(company.tenant_schema_name, 'products');
  const itemTable = tenantTable(company.tenant_schema_name, 'order_items');
  const addressTable = tenantTable(company.tenant_schema_name, 'addresses');
  const shipmentTable = tenantTable(company.tenant_schema_name, 'shipments');
  const body = parsed.body;
  const status = body.status ?? null;
  const shipmentStatus = body.shipmentStatus
    ?? (status === 'shipped' ? 'in_transit' : status === 'delivered' ? 'delivered' : status === 'returned' ? 'returned' : null);
  const [current] = await db.query(
    `SELECT status FROM ${orderTable} WHERE id = $1::uuid AND company_id = $2::uuid LIMIT 1`,
    [orderId, vendorId],
  );
  if (!current) return errorResponse('Order not found.', 404);
  if (status && !(transitions[current.status] || new Set()).has(status)) {
    return errorResponse(`لا يمكن تغيير حالة الطلب من ${current.status} إلى ${status}.`, 409);
  }

  const updateSql = `
    WITH locked AS (
      SELECT id, status FROM ${orderTable}
      WHERE id = $1::uuid AND company_id = $2::uuid
      FOR UPDATE
    ), changed AS (
      UPDATE ${orderTable} o SET
        status = COALESCE($3::text, o.status),
        shipping_total = COALESCE($4::numeric, o.shipping_total),
        grand_total = o.subtotal - o.discount_total + COALESCE($4::numeric, o.shipping_total) + o.tax_total,
        confirmed_at = CASE WHEN $3::text = 'confirmed' THEN COALESCE(o.confirmed_at, NOW()) ELSE o.confirmed_at END,
        delivered_at = CASE WHEN $3::text = 'delivered' THEN COALESCE(o.delivered_at, NOW()) ELSE o.delivered_at END,
        cancelled_at = CASE WHEN $3::text = 'cancelled' THEN COALESCE(o.cancelled_at, NOW()) ELSE o.cancelled_at END,
        updated_at = NOW()
      FROM locked old
      WHERE o.id = old.id
        AND ($3::text IS NULL OR $3::text = old.status
          OR (old.status = 'pending' AND $3::text = ANY(ARRAY['confirmed', 'processing', 'cancelled']))
          OR (old.status = 'confirmed' AND $3::text = ANY(ARRAY['processing', 'shipped', 'delivered', 'cancelled']))
          OR (old.status = 'processing' AND $3::text = ANY(ARRAY['confirmed', 'shipped', 'delivered', 'cancelled']))
          OR (old.status = 'shipped' AND $3::text = ANY(ARRAY['delivered', 'returned']))
          OR (old.status = 'delivered' AND $3::text = ANY(ARRAY['returned', 'refunded']))
          OR (old.status = 'returned' AND $3::text = 'refunded'))
      RETURNING o.id, o.address_id, o.status, o.shipping_total, o.grand_total, old.status AS previous_status
    ), restocked AS (
      UPDATE ${productTable} p
      SET stock_quantity = p.stock_quantity + line_item.quantity, updated_at = NOW()
      FROM ${itemTable} line_item, changed current_order
      WHERE line_item.order_id = current_order.id
        AND line_item.product_id = p.id
        AND current_order.status = 'cancelled'
        AND current_order.previous_status <> 'cancelled'
      RETURNING p.id
    ), saved_shipment AS (
      INSERT INTO ${shipmentTable} AS current_shipment (order_id, carrier, tracking_number, status, shipping_address)
      SELECT current_order.id, $9::text, $10::text, COALESCE($5::text, 'pending'),
        jsonb_strip_nulls(jsonb_build_object(
          'recipientName', address.recipient_name, 'phone', address.phone,
          'country', address.country, 'governorate', address.governorate,
          'city', address.city, 'district', address.district, 'street', address.street,
          'building', address.building, 'apartment', address.apartment,
          'postalCode', address.postal_code, 'notes', address.notes
        ))
      FROM changed current_order
      LEFT JOIN ${addressTable} address ON address.id = current_order.address_id
      ON CONFLICT (order_id) DO UPDATE SET
        carrier = CASE WHEN $6::boolean THEN EXCLUDED.carrier ELSE current_shipment.carrier END,
        tracking_number = CASE WHEN $7::boolean THEN EXCLUDED.tracking_number ELSE current_shipment.tracking_number END,
        status = CASE WHEN $8::boolean THEN EXCLUDED.status ELSE current_shipment.status END,
        shipped_at = CASE WHEN COALESCE($5::text, current_shipment.status) IN ('picked_up', 'in_transit') THEN COALESCE(current_shipment.shipped_at, NOW()) ELSE current_shipment.shipped_at END,
        delivered_at = CASE WHEN COALESCE($5::text, current_shipment.status) = 'delivered' THEN COALESCE(current_shipment.delivered_at, NOW()) ELSE current_shipment.delivered_at END,
        updated_at = NOW()
      RETURNING id
    )
    SELECT current_order.id, current_order.status, current_order.previous_status,
      current_order.shipping_total, current_order.grand_total,
      (SELECT count(*)::int FROM restocked) AS restocked_products,
      (SELECT id FROM saved_shipment LIMIT 1) AS shipment_id
    FROM changed current_order
  `;

  const params = [
    orderId,
    vendorId,
    status,
    body.shippingFee === undefined ? null : body.shippingFee,
    shipmentStatus,
    body.carrier !== undefined,
    body.trackingNumber !== undefined,
    shipmentStatus !== null,
    body.carrier ?? null,
    body.trackingNumber ?? null,
  ];
  const [updated] = await db.query(updateSql, params);
  if (!updated) return errorResponse('تعذر تطبيق تحديث الحالة؛ ربما تغيرت حالة الطلب بالتزامن. أعد تحميل الطلب.', 409);
  await writeAudit(db, c, c.get('adminUser')?.id ?? null, 'order.update', 'order', orderId, {
    vendorId,
    previousStatus: updated.previous_status,
    status: updated.status,
    shipmentStatus,
    carrierChanged: body.carrier !== undefined,
    trackingNumberChanged: body.trackingNumber !== undefined,
    shippingFee: body.shippingFee ?? null,
    restockedProducts: updated.restocked_products,
  });
  const data = await loadOrderDetails(db, vendorId, orderId, governorates);
  return jsonResponse(ok(data, 'تم تحديث الطلب وبيانات الشحن.'));
});

export default orders;
