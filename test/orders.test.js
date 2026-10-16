import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateOrderUpdate } from '../src/routes/orders.js';

const orderRoutes = readFileSync(new URL('../src/routes/orders.js', import.meta.url), 'utf8');
const orderService = readFileSync(new URL('../src/services/orderService.js', import.meta.url), 'utf8');

test('accepts status, carrier, tracking and shipping fee updates', () => {
  assert.deepEqual(validateOrderUpdate({
    status: 'shipped',
    shipmentStatus: 'in_transit',
    carrier: 'شركة الشحن',
    trackingNumber: 'TRK-12345',
    shippingFee: 35,
  }), []);
});

test('rejects unsupported statuses and invalid shipping values', () => {
  const errors = validateOrderUpdate({ status: 'unknown', carrier: 7, shippingFee: -1 });
  assert.ok(errors.some((message) => message.includes('حالة الطلب')));
  assert.ok(errors.some((message) => message.includes('شركة الشحن')));
  assert.ok(errors.some((message) => message.includes('رسوم الشحن')));
});

test('rejects empty updates and oversized tracking identifiers', () => {
  assert.ok(validateOrderUpdate({}).some((message) => message.includes('لم يتم')));
  assert.ok(validateOrderUpdate({ trackingNumber: 'x'.repeat(161) }).some((message) => message.includes('رقم التتبع')));
});

test('admin order list exposes merchant shipment details and supports shipment-status filtering', () => {
  assert.match(orderRoutes, /c\.req\.query\('shipmentStatus'\)/);
  assert.match(orderRoutes, /shipmentStatus, companyId/);
  assert.match(orderService, /orders\.shipment_status = \$\$\{values\.length\}/);
  assert.match(orderService, /s\.status AS shipment_status, s\.carrier, s\.tracking_number/);
  assert.match(orderService, /customerPhone: row\.customer_phone/);
});

test('admin shipment notifications include active public device tokens and return delivery status', () => {
  const notifier = orderRoutes.slice(orderRoutes.indexOf('async function notifyCustomerShipment'), orderRoutes.indexOf('async function loadCompany'));
  assert.match(notifier, /FROM public\.notification_contacts n/);
  assert.match(notifier, /UNION/);
  assert.match(notifier, /FROM app\.device_tokens d/);
  assert.match(notifier, /d\.company_id IS NULL/);
  assert.match(notifier, /d\.enabled IS TRUE/);
  assert.match(orderRoutes, /ok\(\{ \.\.\.data, notification \}/);
});
