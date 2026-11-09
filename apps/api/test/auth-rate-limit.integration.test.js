import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createRedisClient } from '../src/config/redis.js';

const redisUrl = process.env.REDIS_URL;
const integration = Boolean(redisUrl);
let firstRedis;
let secondRedis;
const servers = [];

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function attempt(url, path, body = {}) {
  return fetch(`${url}/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const noDatabase = {
  async $queryRaw() {
    throw new Error('Authentication handler must not run for invalid test payloads');
  },
};

before(async () => {
  if (!integration) return;
  firstRedis = createRedisClient(redisUrl);
  secondRedis = createRedisClient(redisUrl);
  await Promise.all([firstRedis.connect(), secondRedis.connect()]);
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const client of [firstRedis, secondRedis]) {
    if (client?.isOpen) await client.quit();
  }
});

test('Redis login and registration limits are shared across API instances and fail closed', {
  skip: !integration,
  timeout: 30_000,
}, async () => {
  const namespace = `test:${randomUUID()}`;
  const firstUrl = await listen(createApp({
    prismaClient: noDatabase,
    rateLimitRedisClient: firstRedis,
    rateLimitNamespace: namespace,
  }));
  const secondUrl = await listen(createApp({
    prismaClient: noDatabase,
    rateLimitRedisClient: secondRedis,
    rateLimitNamespace: namespace,
  }));

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await attempt(firstUrl, 'login')).status, 400);
  }
  assert.equal((await attempt(firstUrl, 'login')).status, 429, 'login is limited after 10 attempts');

  const registerNamespace = `test:${randomUUID()}`;
  const registerA = await listen(createApp({
    prismaClient: noDatabase,
    rateLimitRedisClient: firstRedis,
    rateLimitNamespace: registerNamespace,
  }));
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await attempt(registerA, 'register')).status, 400);
  }
  assert.equal((await attempt(registerA, 'register')).status, 429, 'registration is limited after 5 attempts');

  const sharedNamespace = `test:${randomUUID()}`;
  const sharedA = await listen(createApp({
    prismaClient: noDatabase,
    rateLimitRedisClient: firstRedis,
    rateLimitNamespace: sharedNamespace,
  }));
  const sharedB = await listen(createApp({
    prismaClient: noDatabase,
    rateLimitRedisClient: secondRedis,
    rateLimitNamespace: sharedNamespace,
  }));
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await attempt(sharedA, 'register')).status, 400);
    assert.equal((await attempt(sharedB, 'register')).status, 400);
  }
  assert.equal((await attempt(sharedA, 'register')).status, 400, 'fifth shared attempt is allowed');
  assert.equal((await attempt(sharedB, 'register')).status, 429, 'sixth shared attempt is rejected');

  const unavailableRedis = createRedisClient('redis://127.0.0.1:1/0', {
    socket: { connectTimeout: 200, reconnectStrategy: false },
  });
  const unavailableUrl = await listen(createApp({
    prismaClient: noDatabase,
    rateLimitRedisClient: unavailableRedis,
    rateLimitNamespace: `test:${randomUUID()}`,
  }));
  const unavailableResponse = await attempt(unavailableUrl, 'login');
  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(await unavailableResponse.json(), { error: 'Internal server error' });
  if (unavailableRedis.isOpen) unavailableRedis.destroy();
});
