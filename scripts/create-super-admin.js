import { createInterface } from 'node:readline';
import { neon } from '@neondatabase/serverless';
import { hashPassword } from '../src/lib/password.js';

function ask(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => readline.question(question, (answer) => {
    readline.close();
    resolve(answer.trim());
  }));
}

function askHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Run this bootstrap command from an interactive terminal so the password is not echoed.');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (error = null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      const input = chunk.toString('utf8');
      if (input === '\u0003') return finish(new Error('Cancelled.'));
      if (input === '\r' || input === '\n') return finish();
      if (input === '\u007f' || input === '\b') {
        value = [...value].slice(0, -1).join('');
        return;
      }
      value += input;
    };
    stdin.on('data', onData);
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL in the environment or .dev.vars before bootstrapping.');
const sql = neon(databaseUrl);
const existing = await sql`SELECT COUNT(*)::int AS count FROM public.admin_users WHERE role = 'super_admin'`;
if (Number(existing[0]?.count || 0) > 0) {
  throw new Error('A super admin already exists. Use the Employees page to add further accounts.');
}

const fullName = await ask('Super admin name: ');
const email = (await ask('Super admin email: ')).toLowerCase();
if (fullName.length < 2 || fullName.length > 160) throw new Error('Name must be between 2 and 160 characters.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
const password = await askHidden('Password (minimum 12 characters; input hidden): ');
if (password.length < 12 || password.length > 1024) throw new Error('Password must be at least 12 characters.');
const confirmation = await askHidden('Confirm password: ');
if (password !== confirmation) throw new Error('Passwords do not match.');

const passwordHash = await hashPassword(password);
const [user] = await sql`
  INSERT INTO public.admin_users (email, full_name, password_hash, role, assigned_governorates)
  VALUES (${email}, ${fullName}, ${passwordHash}, 'super_admin', ARRAY[]::TEXT[])
  RETURNING id, email, full_name, role
`;
console.log(`Created the initial super admin ${user.email} (${user.id}).`);
