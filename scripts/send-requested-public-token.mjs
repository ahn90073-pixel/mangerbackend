import { sendFcmNotification } from '../src/lib/fcm.js';
const token = 'fpxwdMNaSn6HdCuRfi0kw0:APA91bHP_dSI-Um8lPpyepcbXx3utbIYajZdT60P8LtGH6UOSetJVVy6RkQIqZdNlNnbwCsmfuD-28QuFiLtYCObYwI4eSn_aFZBBJWAV5jPsoXEgMNmIKw';
const account = JSON.parse(process.env.FCM_PUBLIC_SERVICE_ACCOUNT_JSON);
if (account.project_id !== 'storonline-z') throw new Error(`Wrong Firebase project: ${account.project_id}`);
const result = await sendFcmNotification(
  { FCM_PUBLIC_SERVICE_ACCOUNT_JSON: process.env.FCM_PUBLIC_SERVICE_ACCOUNT_JSON },
  [token],
  { appName: 'online-store', title: 'اختبار التوكن المحدد', body: 'تم إرسال الإشعار إلى التوكن المحدد فقط عبر Backend' },
);
console.log(JSON.stringify({ project: account.project_id, configured: result.configured, sent: result.sent, failed: result.failed }));
if (result.sent !== 1 || result.failed !== 0) process.exit(1);
