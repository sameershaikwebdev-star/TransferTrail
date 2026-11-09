import bcrypt from 'bcryptjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterEach, test } from 'node:test';
import { createUsersRouter } from '../src/routes/users.routes.js';
import { createAdminRouter } from '../src/routes/admin.routes.js';
import { verifyActorAssertion } from '../src/config/actor-assertion.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/config/auth.js';

if ([...(process.env.JWT_ACCESS_SECRET ?? '')].length < 32) process.env.JWT_ACCESS_SECRET = 'balancevault-users-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
if (!process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY) process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY = 'cd'.repeat(32);
const userId = '10000000-0000-4000-8000-000000000001';
let server;
let baseUrl;
let currentRole = 'ADMIN';

function accessToken() {
  return jwt.sign({ ver: 0, role: 'ADMIN' }, process.env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256', subject: userId, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: '15m',
  });
}
async function listen(app) {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => { currentRole = 'ADMIN'; if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); server = null; } });

test('profile HTTP routes return safe data and only update the verified caller full name', async () => {
  const profile = { id: userId, fullName: 'Original Name', email: 'holder@example.test', role: 'ACCOUNT_HOLDER', isActive: true, tokenVersion: 0, createdAt: new Date('2026-01-01T00:00:00Z') };
  let updateArgs;
  const prisma = {
    user: { async findUnique({ select }) { return Object.fromEntries(Object.keys(select).map((key) => [key, profile[key]])); } },
    async $queryRaw(strings, ...args) {
      updateArgs = args;
      return [{ ...profile, fullName: args[1] }];
    },
  };
  const app = express(); app.use(express.json()); app.use('/api/users', createUsersRouter(prisma)); await listen(app);
  const authorization = { authorization: `Bearer ${accessToken()}` };
  const read = await fetch(`${baseUrl}/api/users/me`, { headers: authorization });
  assert.equal(read.status, 200);
  const data = await read.json();
  assert.equal(data.user.id, userId);
  assert.equal(data.user.fullName, 'Original Name');
  assert.equal(Object.hasOwn(data.user, 'passwordHash'), false);

  const update = await fetch(`${baseUrl}/api/users/me`, {
    method: 'PATCH', headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ fullName: 'Changed Name', userId: '10000000-0000-4000-8000-000000000099', role: 'ADMIN' }),
  });
  assert.equal(update.status, 400, 'strict profile input rejects identity and role fields');
  const validUpdate = await fetch(`${baseUrl}/api/users/me`, {
    method: 'PATCH', headers: { ...authorization, 'content-type': 'application/json' }, body: JSON.stringify({ fullName: 'Changed Name' }),
  });
  assert.equal(validUpdate.status, 200);
  assert.equal(updateArgs[0], userId);
  assert.equal(updateArgs[1], 'Changed Name');
});

test('profile routes require a verified bearer token', async () => {
  const app = express(); app.use('/api/users', createUsersRouter({})); await listen(app);
  const response = await fetch(`${baseUrl}/api/users/me`);
  assert.equal(response.status, 401);
});

test('administrator status endpoint uses req.auth and rejects role changes', async () => {
  let callArgs;
  const prisma = {
    user: { async findUnique() { return { id: userId, role: currentRole, isActive: true, tokenVersion: 0 }; } },
    async $queryRaw(_strings, ...args) { callArgs = args; return [{ changed: true }]; },
  };
  const app = express(); app.use(express.json()); app.use('/api/admin', createAdminRouter(prisma)); await listen(app);
  const response = await fetch(`${baseUrl}/api/admin/users/10000000-0000-4000-8000-000000000002/status`, {
    method: 'PATCH', headers: { authorization: `Bearer ${accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ isActive: false, role: 'ADMIN' }),
  });
  assert.equal(response.status, 400);
  const success = await fetch(`${baseUrl}/api/admin/users/10000000-0000-4000-8000-000000000002/status`, {
    method: 'PATCH', headers: { authorization: `Bearer ${accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(success.status, 200);
  assert.equal(callArgs[0], userId);
  assert.equal(callArgs[1], '10000000-0000-4000-8000-000000000002');
  assert.equal(callArgs[2], false);
});

test('admin invitation API returns a one-time 256-bit token and stores only its hash', async () => {
  let args;
  const prisma = {
    user: { async findUnique() { return { id: userId, role: currentRole, isActive: true, tokenVersion: 0 }; } },
    async $queryRaw(_strings, ...values) {
      args = values;
      return [{ id: values[1], fullName: values[2], email: values[3], role: values[4], expiresAt: values[6], createdAt: new Date() }];
    },
  };
  const app = express(); app.use(express.json()); app.use('/api/admin', createAdminRouter(prisma)); await listen(app);
  const response = await fetch(`${baseUrl}/api/admin/invitations`, {
    method: 'POST', headers: { authorization: `Bearer ${accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fullName: 'Auditor One', email: '  AUDITOR@example.test ', role: 'AUDITOR' }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.invitation.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.invitation.email, 'auditor@example.test');
  assert.equal(args[0], userId, 'issuer comes from verified req.auth');
  assert.equal(args[3], 'auditor@example.test');
  assert.equal(args[4], 'AUDITOR');
  assert.equal(args[5], createHash('sha256').update(body.invitation.token).digest('hex'));
  assert.equal(args[0], userId);
  assert.equal(verifyActorAssertion(userId, 'INVITATION_CREATE', {
    issuedAt: args[8], nonce: args[9], contextHash: args[10], signature: args[11],
  }, [...args.slice(1, 6), String(args[7])]), true);
  assert.equal(Object.hasOwn(body.invitation, 'tokenHash'), false);

  const escalated = await fetch(`${baseUrl}/api/admin/invitations`, {
    method: 'POST', headers: { authorization: `Bearer ${accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fullName: 'Bad', email: 'bad@example.test', role: 'ACCOUNT_HOLDER', actorId: 'spoofed' }),
  });
  assert.equal(escalated.status, 400);
});

test('non-admin database roles cannot create privileged-user invitations', async () => {
  currentRole = 'AUDITOR';
  const app = express(); app.use(express.json()); app.use('/api/admin', createAdminRouter({
    user: { async findUnique() { return { id: userId, role: currentRole, isActive: true, tokenVersion: 0 }; } },
  }));
  await listen(app);
  const response = await fetch(`${baseUrl}/api/admin/invitations`, {
    method: 'POST', headers: { authorization: `Bearer ${accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fullName: 'Auditor', email: 'auditor@example.test', role: 'ADMIN' }),
  });
  assert.equal(response.status, 403);
});

test('admin user search and filters are passed as validated server-side database criteria', async () => {
  let findArgs;
  const app = express();
  app.use('/api/admin', createAdminRouter({
    user: {
      async findUnique() { return { id: userId, role: 'ADMIN', isActive: true, tokenVersion: 0 }; },
      async findMany(args) { findArgs = args; return []; },
    },
  }));
  await listen(app);
  const response = await fetch(`${baseUrl}/api/admin/users?search=alice&role=AUDITOR&status=ACTIVE`, { headers: { authorization: `Bearer ${accessToken()}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(findArgs.where, {
    role: 'AUDITOR', isActive: true,
    OR: [
      { fullName: { contains: 'alice', mode: 'insensitive' } },
      { email: { contains: 'alice', mode: 'insensitive' } },
    ],
  });
});

test('account permission updates enforce administrator identity, exact input, signed scope and conflict handling', async () => {
  const accountId = '20000000-0000-4000-8000-000000000001';
  const holderId = '30000000-0000-4000-8000-000000000001';
  const adminPassword = 'test-admin-password';
  const adminPasswordHash = await bcrypt.hash(adminPassword, 4);
  let args;
  let failure;
  const prisma = {
    user: { async findUnique() { return { id: userId, role: currentRole, isActive: true, tokenVersion: 0 }; } },
    account: { async findFirst() { return { id: accountId, status: 'ACTIVE' }; } },
    accountPermission: { async findMany() { return []; } },
    async $queryRaw(_strings, ...values) {
      if (failure) throw { meta: { code: failure } };
      args = values;
      return [{ changed: true }];
    },
  };
  const authPrismaClient = {
  user: {
    async findUnique() {
      return {
        passwordHash: adminPasswordHash,
        isActive: true,
        role: 'ADMIN',
      };
    },
  },
};
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter(prisma, { authPrismaClient }));
  await listen(app);
  const path = `${baseUrl}/api/admin/accounts/${accountId}/permissions`;
  const headers = { authorization: `Bearer ${accessToken()}`, 'content-type': 'application/json' };
  const body = {
  canDeposit: true,
  canWithdraw: false,
  canTransfer: true,
  expected: {
    canDeposit: false,
    canWithdraw: false,
    canTransfer: false,
  },
  adminPassword,
};
  const patch = (data = body) => fetch(`${path}/${holderId}`, { method: 'PATCH', headers, body: JSON.stringify(data) });
  assert.equal((await fetch(path)).status, 401);
  currentRole = 'ACCOUNT_HOLDER';
  assert.equal((await fetch(path, { headers })).status, 403);
  assert.equal((await patch()).status, 403);
  currentRole = 'AUDITOR';
  assert.equal((await patch()).status, 403);
  currentRole = 'ADMIN';
  assert.equal((await fetch(path, { headers })).status, 200);
  assert.equal((await patch({ ...body, actorId: holderId })).status, 400);
  assert.equal((await patch({ ...body, canDeposit: 'true' })).status, 400);
  assert.equal((await patch({ canDeposit: true, canWithdraw: true, canTransfer: true })).status, 400);
  assert.equal(
  (await patch({ ...body, adminPassword: 'incorrect-password' })).status,
  403
);
  const success = await patch();
  assert.equal(success.status, 200);
  assert.equal(args[0], userId);
  assert.equal(verifyActorAssertion(userId, 'ACCOUNT_PERMISSIONS_UPDATE', {
    issuedAt: args[9], nonce: args[10], contextHash: args[11], signature: args[12],
  }, args.slice(1, 9)), true);
  for (const [code, status] of [['42501', 403], ['22023', 422], ['P0002', 404], ['40001', 409]]) {
    failure = code;
    assert.equal((await patch()).status, status);
  }
});
