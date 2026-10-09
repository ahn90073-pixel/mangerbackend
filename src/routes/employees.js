import { Hono } from 'hono';
import { createDb } from '../lib/db.js';
import { EGYPT_GOVERNORATES, normalizeGovernorateList } from '../lib/governorates.js';
import { hashPassword } from '../lib/password.js';
import { errorResponse, jsonResponse, ok } from '../lib/response.js';
import { superAdminGuard } from '../middleware/adminAuth.js';
import { isUuid, readJson } from '../lib/validation.js';
import { writeAudit } from '../lib/audit.js';

const employees = new Hono();

employees.get('/', ...superAdminGuard, async (c) => {
  const rows = await createDb(c.env).query(
    `SELECT id, email, full_name, role, assigned_governorates, is_active, last_login_at, created_at
     FROM public.admin_users WHERE role = 'employee' ORDER BY created_at DESC`,
    [],
  );
  return jsonResponse(ok({ items: rows, governorates: EGYPT_GOVERNORATES }));
});

employees.post('/', ...superAdminGuard, async (c) => {
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  const { fullName, email: rawEmail, password, assignedGovernorates: rawGovernorates } = parsed.body;
  const fullNameText = typeof fullName === 'string' ? fullName.trim() : '';
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  const governorates = normalizeGovernorateList(rawGovernorates);
  if (fullNameText.length < 2 || fullNameText.length > 160) return errorResponse('الاسم مطلوب ويجب ألا يتجاوز 160 حرفًا.', 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return errorResponse('البريد الإلكتروني غير صالح.', 400);
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) return errorResponse('كلمة المرور يجب أن تتكون من 12 حرفًا على الأقل.', 400);
  if (!governorates || governorates.length === 0) return errorResponse('اختر محافظة واحدة على الأقل للموظف.', 400);

  const db = createDb(c.env);
  const passwordHash = await hashPassword(password);
  let employee;
  try {
    [employee] = await db.query(
      `INSERT INTO public.admin_users (email, full_name, password_hash, role, assigned_governorates, created_by)
       VALUES ($1, $2, $3, 'employee', $4::text[], $5::uuid)
       RETURNING id, email, full_name, role, assigned_governorates, is_active, created_at`,
      [email, fullNameText, passwordHash, governorates, c.get('adminUser').id],
    );
  } catch (error) {
    if (error?.code === '23505') return errorResponse('يوجد حساب مسجل بهذا البريد الإلكتروني.', 409);
    throw error;
  }
  await writeAudit(db, c, c.get('adminUser').id, 'employee.create', 'admin_user', employee.id, {
    email: employee.email,
    assignedGovernorates: employee.assigned_governorates,
  });
  return jsonResponse(ok(employee, 'تم إنشاء حساب الموظف.'), 201);
});

employees.patch('/:id/status', ...superAdminGuard, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return errorResponse('معرّف الموظف غير صالح.', 400);
  const parsed = await readJson(c);
  if (parsed.error) return parsed.error;
  if (typeof parsed.body.isActive !== 'boolean') return errorResponse('قيمة isActive يجب أن تكون منطقية.', 400);
  if (id === c.get('adminUser').id) return errorResponse('لا يمكن إيقاف حسابك الحالي.', 409);

  const db = createDb(c.env);
  const [employee] = await db.query(
    `UPDATE public.admin_users SET is_active = $2, token_version = token_version + 1, updated_at = NOW()
     WHERE id = $1::uuid AND role = 'employee'
     RETURNING id, email, full_name, role, assigned_governorates, is_active`,
    [id, parsed.body.isActive],
  );
  if (!employee) return errorResponse('الموظف غير موجود.', 404);
  await writeAudit(db, c, c.get('adminUser').id, parsed.body.isActive ? 'employee.activate' : 'employee.deactivate', 'admin_user', id, {});
  return jsonResponse(ok(employee, 'تم تحديث حالة الموظف.'));
});

export default employees;
