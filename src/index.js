import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { errorResponse } from './lib/response.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import vendorRoutes from './routes/vendors.js';
import productRoutes from './routes/products.js';
import settlementRoutes from './routes/settlements.js';
import orderRoutes from './routes/orders.js';
import auditLogRoutes from './routes/auditLogs.js';

const app = new Hono();

app.use('*', logger());
app.use('*', secureHeaders());
app.use('*', cors({
  origin: (origin, c) => {
    if (!origin) return '';
    const allowlist = String(c.env.ADMIN_CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
    return allowlist.includes(origin) ? origin : '';
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));

app.get('/health', (c) => c.json({ success: true, service: 'mange-admin-backend', status: 'healthy' }));
app.route('/api/admin/auth', authRoutes);
app.route('/api/admin/dashboard', dashboardRoutes);
app.route('/api/admin/vendors', vendorRoutes);
app.route('/api/admin/products', productRoutes);
app.route('/api/admin/settlements', settlementRoutes);
app.route('/api/admin/orders', orderRoutes);
app.route('/api/admin/audit-logs', auditLogRoutes);

app.notFound((c) => errorResponse('Route not found.', 404));
app.onError((error, c) => {
  console.error('Unhandled API exception:', error?.code || error?.name || 'unknown');
  return errorResponse(error?.status === 503 ? error.message : 'Internal server error.', error?.status || 500);
});

export default app;
