import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
dotenv.config({ path: path.join(root, '.env') });

function ask(prompt) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => readline.question(prompt, (answer) => { readline.close(); resolve(answer); }));
}

function askSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Bootstrap password input requires an interactive terminal.');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') return finish(new Error('Bootstrap cancelled.'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

function safeErrorMessage(error) {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (/^permission denied for (?:database|schema|table|sequence|function|role) [A-Za-z0-9_."-]{1,120}$/i.test(message)) {
    return message;
  }
  return 'Database operation failed';
}

const databaseUrl = process.env.BALANCEVAULT_BOOTSTRAP_DATABASE_URL;
if (!databaseUrl) {
  console.error('Set BALANCEVAULT_BOOTSTRAP_DATABASE_URL to the operator-only database connection.');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
let stage = 'connect';
try {
  await client.connect();
  stage = 'database_confirmation';
  const { rows: [db] } = await client.query('SELECT current_database() AS name');
  const expected = new URL(databaseUrl).pathname.slice(1);
  console.log(`Connected database: ${db.name}`);
  if (expected !== db.name || await ask('Type this database name to continue: ') !== db.name) {
    throw new Error('Database confirmation did not match. No administrator was created.');
  }

  const fullName = (await ask('Administrator full name: ')).trim();
  const email = (await ask('Administrator email: ')).trim().toLowerCase();
  const password = await askSecret('Choose an administrator password (input hidden): ');
  const confirmation = await askSecret('Confirm password (input hidden): ');
  if (!fullName || fullName.length > 100 || !/^\S+@\S+\.\S+$/.test(email)
      || password !== confirmation || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Input validation failed. No administrator was created.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  stage = 'set_role';
  await client.query('SET ROLE balancevault_bootstrap_operator');
  stage = 'bootstrap_function';
  const { rows: [user] } = await client.query(
    'SELECT * FROM public.bootstrap_first_admin($1::uuid, $2::text, $3::text, $4::text)',
    [randomUUID(), fullName, email, passwordHash],
  );
  console.log(`First administrator created: ${user.email} (${user.id}). Sign in through the normal login page.`);
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : 'unknown';
  console.error(`Bootstrap failed at ${stage}; code ${code}: ${safeErrorMessage(error)}.`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
