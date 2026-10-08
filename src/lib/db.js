import { neon } from '@neondatabase/serverless';

export function createDb(env) {
  if (!env?.DATABASE_URL) {
    const error = new Error('DATABASE_URL is not configured for this Worker.');
    error.status = 503;
    throw error;
  }
  return neon(env.DATABASE_URL);
}
