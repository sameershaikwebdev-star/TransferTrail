import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import app from '../src/app.js';
import { createApp } from '../src/app.js';

let server;
let baseUrl;
const databaseUrl = process.env.BALANCEVAULT_TEST_RUNTIME_DATABASE_URL;
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';

if (databaseUrl && (!databaseName.endsWith('_test') || databaseName === 'balancevault_dev')) {
  throw new Error('BALANCEVAULT_TEST_RUNTIME_DATABASE_URL must target a disposable database ending in _test.');
}

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('GET /api/health reports application health', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/i);
  assert.equal(response.headers.get('strict-transport-security'), null, 'local HTTP must not receive HSTS');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.deepEqual(await response.json(), {
    application: 'BalanceVault',
    status: 'healthy',
  });
});

test('unknown API routes return a JSON 404', async () => {
  const response = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'API route not found' });
});

test('JSON request bodies are bounded before reaching route handlers', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'unused@example.test', padding: 'x'.repeat(70_000) }),
  });
  assert.equal(response.status, 413);
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/i);
});

async function requestReady(prismaClient, rateLimitRedisClient = {
  isReady: true,
  sendCommand: async () => 'PONG',
  ping: async () => 'PONG',
}) {
  const instance = createApp({ prismaClient, rateLimitRedisClient }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    instance.once('listening', resolve);
    instance.once('error', reject);
  });
  try {
    return await fetch(`http://127.0.0.1:${instance.address().port}/api/ready`);
  } finally {
    instance.closeAllConnections();
    await new Promise((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())));
  }
}

test('GET /api/ready returns ready when PostgreSQL responds', {
  skip: !databaseUrl,
  timeout: 10_000,
}, async () => {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const response = await requestReady(prisma);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { application: 'BalanceVault', status: 'ready' });
  } finally {
    await prisma.$disconnect();
  }
});

test('GET /api/ready returns a generic 503 when PostgreSQL is unavailable', {
  skip: !databaseUrl,
  timeout: 10_000,
}, async () => {
  const unavailableUrl = new URL(databaseUrl);
  unavailableUrl.port = '1';
  unavailableUrl.searchParams.set('connection_timeout', '300');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: unavailableUrl.toString(), connectionTimeoutMillis: 300 }),
  });
  try {
    const response = await requestReady(prisma);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { application: 'BalanceVault', status: 'not_ready' });
  } finally {
    await prisma.$disconnect();
  }
});

test('GET /api/ready returns a generic 503 when Redis is unavailable', async () => {
  const response = await requestReady({ $queryRaw: async () => [{ '?column?': 1 }] }, {
    isReady: true,
    sendCommand: async () => 'PONG',
    ping: async () => { throw new Error('Redis unavailable'); },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { application: 'BalanceVault', status: 'not_ready' });
});
