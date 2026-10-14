import { neon } from '@neondatabase/serverless';
import { createSign } from 'node:crypto';
const sql = neon(process.env.DATABASE_URL);
const contacts = await sql`
  SELECT DISTINCT fcm_token FROM public.notification_contacts
  WHERE audience='customer' AND app_name='online-store' AND push_enabled IS TRUE
    AND fcm_token IS NOT NULL AND fcm_token<>''
`;
if (!contacts.length) throw new Error('No enabled customer tokens found');
const account = JSON.parse(process.env.FCM_PUBLIC_SERVICE_ACCOUNT_JSON);
const now = Math.floor(Date.now()/1000), b64 = (v) => Buffer.from(v).toString('base64url');
const unsigned = `${b64(JSON.stringify({alg:'RS256',typ:'JWT'}))}.${b64(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}))}`;
const signer = createSign('RSA-SHA256'); signer.update(unsigned);
const assertion = `${unsigned}.${signer.sign(account.private_key.replace(/\\n/g,'\n'),'base64url')}`;
const oauth = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
if(!oauth.ok) throw new Error(`FCM OAuth failed (${oauth.status})`);
const {access_token: accessToken} = await oauth.json();
let sent=0, failed=0;
for (const {fcm_token: token} of contacts) {
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({message:{token,notification:{title:'اختبار',body:'هذا إشعار تجريبي للجمهور'}}})});
  if(response.ok) sent++; else failed++;
}
console.log(JSON.stringify({audience:'customer',total:contacts.length,sent,failed}));
if (failed) process.exitCode=1;
