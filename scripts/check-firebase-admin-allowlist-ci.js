import { FirebaseConfigurationError, parseFirebaseAdminEmails } from '../src/lib/firebaseAuth.js';

try {
  const allowedEmails = parseFirebaseAdminEmails(process.env.FIREBASE_ADMIN_EMAILS);
  const initialEmail = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() ?? '';
  if (!allowedEmails.length || !initialEmail || !allowedEmails.includes(initialEmail)) {
    console.error('INITIAL_ADMIN_EMAIL must match one of the configured Firebase admin allowlist entries. No email values were printed.');
    process.exit(1);
  }
  console.log(`Firebase admin allowlist configuration is valid (${allowedEmails.length} authorized account${allowedEmails.length === 1 ? '' : 's'}).`);
} catch (error) {
  if (error instanceof FirebaseConfigurationError) {
    console.error('Firebase admin allowlist is invalid. Provide one to three unique, valid email addresses.');
    process.exit(1);
  }
  throw error;
}
