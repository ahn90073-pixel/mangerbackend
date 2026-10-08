import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOrderUpdate } from '../src/routes/orders.js';

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
