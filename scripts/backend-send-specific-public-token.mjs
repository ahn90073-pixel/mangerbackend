import { neon } from '@neondatabase/serverless';
import { sendFcmNotification } from '../src/lib/fcm.js';
const sql = neon(process.env.DATABASE_URL);
const [contact] = await sql`SELECT fcm_token FROM public.notification_contacts WHERE fcm_token IS NOT NULL AND fcm_token <> '' AND push_enabled IS TRUE ORDER BY updated_at DESC LIMIT 1`;
if (!contact?.fcm_token) throw new Error('No enabled public token found');
const account = JSON.parse(process.env.FCM_PUBLIC_SERVICE_ACCOUNT_JSON);
if (account.project_id !== 'storonline-z') throw new Error(`Wrong Firebase project: ${account.project_id}`);
const result = await sendFcmNotification(
  { FCM_PUBLIC_SERVICE_ACCOUNT_JSON: process.env.FCM_PUBLIC_SERVICE_ACCOUNT_JSON },
  [contact.fcm_token],
  { appName: 'online-store', title: 'اختبار Backend للجمهور', body: 'تم الإرسال عبر Backend باستخدام storonline-z' },
);
console.log(JSON.stringify({ project: account.project_id, configured: result.configured, sent: result.sent, failed: result.failed }));
if (result.sent !== 1 || result.failed !== 0) process.exit(1);
