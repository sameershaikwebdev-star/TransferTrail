import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { after, afterEach, beforeEach, test } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import { createApp } from '../src/app.js';
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '../src/config/auth.js';
import { createAuthenticate } from '../src/middleware/authenticate.js';
import { redisClient } from '../src/config/redis.js';

if ([...(process.env.JWT_ACCESS_SECRET ?? '')].length < 32) {
  process.env.JWT_ACCESS_SECRET = 'balancevault-http-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
}
if (!process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY) {
  process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY = 'ab'.repeat(32);
}

const usersById = new Map();
const usersByEmail = new Map();
let lastInvitationTokenHash;
const runtimeDatabaseUrl = process.env.BALANCEVAULT_TEST_RUNTIME_DATABASE_URL;
const databaseName = runtimeDatabaseUrl ? new URL(runtimeDatabaseUrl).pathname.slice(1) : '';
const databaseIntegration = Boolean(runtimeDatabaseUrl);
if (databaseIntegration && (!databaseName.endsWith('_test') || databaseName === 'balancevault_dev')) {
  throw new Error('BALANCEVAULT_TEST_RUNTIME_DATABASE_URL must target a disposable database ending in _test.');
}

const prismaClient = {
  async $queryRaw(_strings, id, fullName, email, passwordHash) {
    if (_strings.join('').includes('accept_privileged_user_invitation')) {
      lastInvitationTokenHash = fullName;
      const user = { id, fullName: 'Invited Auditor', email: 'invited-auditor@example.test', passwordHash: email, role: 'AUDITOR', isActive: true, tokenVersion: 0, createdAt: new Date() };
      usersById.set(id, user);
      usersByEmail.set(user.email, user);
      return [{ id, fullName: user.fullName, email: user.email, role: user.role, isActive: true, createdAt: user.createdAt }];
    }
    if (_strings.join('').includes('change_user_password')) {
      const [userId, expectedVersion, nextHash] = [id, fullName, email];
      const user = usersById.get(userId);
      if (!user || user.tokenVersion !== expectedVersion || !user.isActive) {
        const error = new Error('password state conflict');
        error.meta = { code: '40001' };
        throw error;
      }
      user.passwordHash = nextHash;
      user.tokenVersion += 1;
      return [{ change_user_password: user.tokenVersion }];
    }
    if (usersByEmail.has(email)) {
      const error = new Error('unique email violation');
      error.code = 'P2010';
      error.meta = { code: '23505' };
      throw error;
    }

    const user = {
      id,
      fullName,
      email,
      passwordHash,
      role: 'ACCOUNT_HOLDER',
      isActive: true,
      tokenVersion: 0,
      createdAt: new Date(),
    };
    usersById.set(id, user);
    usersByEmail.set(email, user);
    return [{ id, fullName, email, role: user.role, isActive: user.isActive, createdAt: user.createdAt, tokenVersion: 0 }];
  },
  user: {
    async findUnique({ where, select }) {
      const user = where.id ? usersById.get(where.id) : usersByEmail.get(where.email);
      if (!user) return null;
      return Object.fromEntries(Object.keys(select).map((field) => [field, user[field]]));
    },
  },
};

let server;
let protectedServer;
let baseUrl;
let protectedUrl;

async function listen(app) {
  const instance = app.listen(0);
  await new Promise((resolve, reject) => {
    instance.once('listening', resolve);
    instance.once('error', reject);
  });
  return { server: instance, url: `http://127.0.0.1:${instance.address().port}` };
}

async function close(instance) {
  instance.closeAllConnections();
  await new Promise((resolve, reject) => {
    instance.close((error) => (error ? reject(error) : resolve()));
  });
}

async function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function register(overrides = {}) {
  return post('/api/auth/register', {
    name: '  Demo Holder  ',
    email: `holder-${crypto.randomUUID()}@example.test`,
    password: 'correct horse battery staple',
    ...overrides,
  });
}

async function login(email, password) {
  return post('/api/auth/login', { email, password });
}

function makeToken(userId, claims = {}, options = {}) {
  return jwt.sign(
    { role: 'ACCOUNT_HOLDER', ver: usersById.get(userId)?.tokenVersion ?? 0, ...claims },
    options.secret ?? process.env.JWT_ACCESS_SECRET,
    {
      algorithm: 'HS256',
      subject: userId,
      issuer: options.issuer ?? JWT_ISSUER,
      audience: options.audience ?? JWT_AUDIENCE,
      expiresIn: options.expiresIn ?? ACCESS_TOKEN_LIFETIME_SECONDS,
    },
  );
}

async function protectedRequest(token, body = {}, query = '') {
  return fetch(`${protectedUrl}/protected${query}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function changePassword(token, body) {
  return fetch(`${baseUrl}/api/auth/change-password`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const appInstance = await listen(createApp({ prismaClient, rateLimitNamespace: `auth-http:${crypto.randomUUID()}` }));
  server = appInstance.server;
  baseUrl = appInstance.url;

  const protectedApp = express();
  protectedApp.use(express.json());
  protectedApp.post('/protected', createAuthenticate(prismaClient), (request, response) => {
    response.json({ auth: request.auth });
  });
  const protectedInstance = await listen(protectedApp);
  protectedServer = protectedInstance.server;
  protectedUrl = protectedInstance.url;
});

afterEach(async () => {
  if (server) await close(server);
  if (protectedServer) await close(protectedServer);
});

after(async () => {
  if (redisClient.isOpen) await redisClient.quit();
});

test('registration hashes the password and returns a safe account-holder response with JWT', async () => {
  const response = await register({ email: '  DEMO.HOLDER@EXAMPLE.TEST  ' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.tokenType, 'Bearer');
  assert.equal(body.expiresIn, 900);
  assert.deepEqual(body.user, {
    id: body.user.id,
    fullName: 'Demo Holder',
    email: 'demo.holder@example.test',
    role: 'ACCOUNT_HOLDER',
  });
  assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);

  const stored = usersById.get(body.user.id);
  assert.ok(stored.passwordHash.startsWith('$2'));
  assert.notEqual(stored.passwordHash, 'correct horse battery staple');

  const claims = jwt.verify(body.accessToken, process.env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  assert.equal(claims.sub, body.user.id);
  assert.equal(claims.role, 'ACCOUNT_HOLDER');
  assert.equal(claims.iss, JWT_ISSUER);
  assert.equal(claims.aud, JWT_AUDIENCE);
  assert.equal(claims.exp - claims.iat, ACCESS_TOKEN_LIFETIME_SECONDS);
});

test('duplicate registration returns conflict without revealing database errors', async () => {
  const email = `duplicate-${crypto.randomUUID()}@example.test`;
  const first = await register({ email });
  const duplicate = await register({ email });
  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'Email is already registered' });
});

test('registration validates name, email and password and rejects role escalation fields', async () => {
  const badName = await register({ name: '   ' });
  const badEmail = await register({ email: 'not-an-email' });
  const shortPassword = await register({ password: 'short' });
  const roleEscalation = await register({ role: 'ADMIN' });
  const inactiveEscalation = await register({ isActive: false });
  for (const response of [badName, badEmail, shortPassword, roleEscalation, inactiveEscalation]) {
    assert.equal(response.status, 400);
  }
});

test('invitation acceptance hashes the password, sends only the token hash to SQL, and cannot choose a role', async () => {
  const token = randomBytes(32).toString('base64url');
  const response = await post('/api/auth/accept-invitation', { token, password: 'a-valid-invited-password' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.user.role, 'AUDITOR');
  assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);
  assert.equal(lastInvitationTokenHash, createHash('sha256').update(token).digest('hex'));
  const stored = usersById.get(body.user.id);
  assert.notEqual(stored.passwordHash, 'a-valid-invited-password');
  assert.equal(await bcrypt.compare('a-valid-invited-password', stored.passwordHash), true);
  const escalation = await post('/api/auth/accept-invitation', { token, password: 'a-valid-invited-password', role: 'ADMIN' });
  assert.equal(escalation.status, 400);
});

test('login succeeds and incorrect password and unknown user share a generic error', async () => {
  const registration = await register();
  const registered = await registration.json();
  const success = await login(registered.user.email.toUpperCase(), 'correct horse battery staple');
  assert.equal(success.status, 200);
  const body = await success.json();
  assert.equal(body.user.id, registered.user.id);
  assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);

  const incorrect = await login(registered.user.email, 'incorrect password');
  const unknown = await login('unknown@example.test', 'incorrect password');
  assert.equal(incorrect.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await incorrect.json(), { error: 'Invalid email or password' });
  assert.deepEqual(await unknown.json(), { error: 'Invalid email or password' });
});

test('inactive users cannot log in', async () => {
  const registration = await register();
  const { user } = await registration.json();
  usersById.get(user.id).isActive = false;
  const response = await login(user.email, 'correct horse battery staple');
  usersById.get(user.id).isActive = true;
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Invalid email or password' });
});

test('password changes require the current password and invalidate existing JWTs', async () => {
  const registration = await register();
  const { user } = await registration.json();
  const signedIn = await login(user.email, 'correct horse battery staple');
  const { accessToken } = await signedIn.json();
  const wrong = await changePassword(accessToken, { currentPassword: 'incorrect', newPassword: 'another strong password' });
  assert.equal(wrong.status, 401);
  const changed = await changePassword(accessToken, { currentPassword: 'correct horse battery staple', newPassword: 'another strong password' });
  assert.equal(changed.status, 200);
  assert.equal(usersById.get(user.id).tokenVersion, 1);
  const oldToken = await protectedRequest(accessToken);
  assert.equal(oldToken.status, 401);
  const newLogin = await login(user.email, 'another strong password');
  assert.equal(newLogin.status, 200);
});

test('middleware rejects missing, malformed, invalid-signature and expired tokens', async () => {
  const userId = [...usersById.keys()][0];
  const missing = await protectedRequest(null);
  const malformed = await protectedRequest('not-a-token');
  const badSignature = await protectedRequest(makeToken(userId, {}, { secret: 'different-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' }));
  const expired = await protectedRequest(makeToken(userId, {}, { expiresIn: -1 }));
  for (const response of [missing, malformed, badSignature, expired]) {
    assert.equal(response.status, 401);
  }
});

test('middleware rejects incorrect issuer and audience', async () => {
  const userId = [...usersById.keys()][0];
  const wrongIssuer = await protectedRequest(makeToken(userId, {}, { issuer: 'other-api' }));
  const wrongAudience = await protectedRequest(makeToken(userId, {}, { audience: 'other-client' }));
  assert.equal(wrongIssuer.status, 401);
  assert.equal(wrongAudience.status, 401);
});

test('middleware rechecks database status after a token is issued', async () => {
  const registration = await register();
  const { accessToken, user } = await registration.json();
  usersById.get(user.id).isActive = false;
  const response = await protectedRequest(accessToken);
  usersById.get(user.id).isActive = true;
  assert.equal(response.status, 401);
});

test('middleware ignores actor, user and role supplied in token, body and query', async () => {
  const registration = await register();
  const { user } = await registration.json();
  const token = makeToken(user.id, { role: 'ADMIN' });
  const response = await protectedRequest(token, {
    actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    role: 'ADMIN',
  }, '?actorId=cccccccc-cccc-4ccc-8ccc-cccccccccccc&userId=dddddddd-dddd-4ddd-8ddd-dddddddddddd&role=ADMIN');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).auth, { userId: user.id, role: 'ACCOUNT_HOLDER' });
});

test('health endpoint remains public', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { application: 'BalanceVault', status: 'healthy' });
});

test('registration HTTP route calls the PostgreSQL function through Prisma', {
  skip: !databaseIntegration,
}, async () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }),
  });
  const appInstance = await listen(createApp({ prismaClient: prisma, rateLimitNamespace: `registration-http:${crypto.randomUUID()}` }));
  try {
    const email = `http-${crypto.randomUUID()}@example.test`;
    const body = {
      name: 'HTTP Integration Holder',
      email,
      password: 'correct horse battery staple',
    };
    const first = await fetch(`${appInstance.url}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 201);
    const registered = await first.json();
    assert.equal(registered.user.email, email);
    assert.equal(registered.user.role, 'ACCOUNT_HOLDER');
    assert.equal(Object.hasOwn(registered.user, 'passwordHash'), false);

    const duplicate = await fetch(`${appInstance.url}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: 'Email is already registered' });
  } finally {
    await close(appInstance.server);
    await prisma.$disconnect();
  }
});
