import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/config/auth.js';

if ([...(process.env.JWT_ACCESS_SECRET ?? '')].length < 32) {
  process.env.JWT_ACCESS_SECRET = 'balancevault-accounts-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
}

const ids = {
  admin: '10000000-0000-4000-8000-000000000001',
  holder: '10000000-0000-4000-8000-000000000002',
  auditor: '10000000-0000-4000-8000-000000000003',
  otherHolder: '10000000-0000-4000-8000-000000000004',
  accountA: '20000000-0000-4000-8000-000000000001',
  accountB: '20000000-0000-4000-8000-000000000002',
  accountPrivate: '20000000-0000-4000-8000-000000000003',
  clearing: '20000000-0000-4000-8000-000000000004',
};

const users = new Map([
  [ids.admin, { id: ids.admin, role: 'ADMIN', isActive: true, tokenVersion: 0 }],
  [ids.holder, { id: ids.holder, role: 'ACCOUNT_HOLDER', isActive: true, tokenVersion: 0 }],
  [ids.auditor, { id: ids.auditor, role: 'AUDITOR', isActive: true, tokenVersion: 0 }],
  [ids.otherHolder, { id: ids.otherHolder, role: 'ACCOUNT_HOLDER', isActive: true, tokenVersion: 0 }],
]);

const accounts = [
  { id: ids.accountA, accountNumber: 'BV-001', type: 'PERSONAL', systemCode: null, status: 'ACTIVE', currencyCode: 'INR', balancePaise: 12500n, createdAt: new Date('2026-01-01T00:00:00Z') },
  { id: ids.accountB, accountNumber: 'BV-002', type: 'BUSINESS', systemCode: null, status: 'ACTIVE', currencyCode: 'INR', balancePaise: 8700n, createdAt: new Date('2026-01-02T00:00:00Z') },
  { id: ids.accountPrivate, accountNumber: 'BV-003', type: 'PERSONAL', systemCode: null, status: 'ACTIVE', currencyCode: 'INR', balancePaise: 99n, createdAt: new Date('2026-01-03T00:00:00Z') },
  { id: ids.clearing, accountNumber: 'BV-CLEAR', type: 'SYSTEM_CLEARING', systemCode: 'CLEARING_DEPOSIT_INR', status: 'ACTIVE', currencyCode: 'INR', balancePaise: -100n, createdAt: new Date('2026-01-04T00:00:00Z') },
];

const permissions = [
  { userId: ids.holder, accountId: ids.accountA, canView: true },
  { userId: ids.holder, accountId: ids.accountB, canView: false },
  { userId: ids.otherHolder, accountId: ids.accountB, canView: true },
  { userId: ids.auditor, accountId: ids.accountA, canView: true },
  { userId: ids.auditor, accountId: ids.clearing, canView: true },
];
const createdRecords = [];

function databaseError(originalCode, constraint) {
  const error = new Error('simulated database error');
  error.code = 'P2010';
  error.meta = {
    driverAdapterError: {
      cause: {
        originalCode,
        ...(constraint ? { constraint: { index: constraint } } : {}),
      },
    },
  };
  return error;
}

function matchesWhere(account, where) {
  if (!where) return true;
  if (where.AND) return where.AND.every((part) => matchesWhere(account, part));
  if (where.id && account.id !== where.id) return false;
  if (where.type?.in && !where.type.in.includes(account.type)) return false;
  if ('systemCode' in where && account.systemCode !== where.systemCode) return false;
  if (where.permissions?.some) {
    const expected = where.permissions.some;
    if (!permissions.some((permission) => permission.accountId === account.id
      && permission.userId === expected.userId
      && permission.canView === expected.canView)) return false;
  }
  return true;
}

const prismaClient = {
  async $queryRaw(_strings, actorId, accountNumber, accountType, holderUserId) {
    const actor = users.get(actorId);
    if (!actor?.isActive || actor.role !== 'ADMIN') throw databaseError('42501');
    const holder = users.get(holderUserId);
    if (!holder?.isActive || holder.role !== 'ACCOUNT_HOLDER') throw databaseError('22023');
    if (accounts.some((account) => account.accountNumber === accountNumber)
      || createdRecords.some((record) => record.account.accountNumber === accountNumber)) {
      throw databaseError('23505', 'Account_accountNumber_key');
    }

    const account = {
      id: crypto.randomUUID(),
      accountNumber,
      type: accountType,
      status: 'ACTIVE',
      currencyCode: 'INR',
      createdAt: new Date(),
    };
    const permission = {
      userId: holderUserId,
      accountId: account.id,
      canView: true,
      canDeposit: false,
      canWithdraw: false,
      canTransfer: false,
    };
    const audit = { actorId, action: 'ACCOUNT_CREATED', entityId: account.id };
    createdRecords.push({ actorId, account, permission, audit });
    return [account];
  },
  user: {
    async findUnique({ where, select }) {
      const user = users.get(where.id);
      if (!user) return null;
      return Object.fromEntries(Object.keys(select).map((field) => [field, user[field]]));
    },
  },
  account: {
    async findMany({ where, select, orderBy }) {
      const rows = accounts.filter((account) => matchesWhere(account, where));
      if (orderBy?.createdAt === 'desc') rows.sort((a, b) => b.createdAt - a.createdAt);
      return rows.map((account) => Object.fromEntries(Object.keys(select).map((field) => [field, account[field]])));
    },
    async findFirst({ where, select }) {
      const account = accounts.find((candidate) => matchesWhere(candidate, where));
      if (!account) return null;
      return Object.fromEntries(Object.keys(select).map((field) => [field, account[field]]));
    },
  },
};

let server;
let baseUrl;

async function startServer() {
  const app = createApp({ prismaClient });
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

function tokenFor(userId) {
  return jwt.sign({ ver: 0 }, process.env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: '15m',
  });
}

async function get(path, userId, token = tokenFor(userId)) {
  return fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(startServer);
beforeEach(() => createdRecords.splice(0));
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  server = null;
});

test('admin can list and read customer accounts but never sees clearing accounts', async () => {
  const list = await get('/api/accounts', ids.admin);
  assert.equal(list.status, 200);
  const { accounts: listed } = await list.json();
  assert.deepEqual(new Set(listed.map((account) => account.id)), new Set([ids.accountA, ids.accountB, ids.accountPrivate]));
  assert.ok(listed.every((account) => !('systemCode' in account) && !('balancePaise' in account)));

  const detail = await get(`/api/accounts/${ids.accountB}`, ids.admin);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).account.id, ids.accountB);

  const balance = await get(`/api/accounts/${ids.accountB}/balance`, ids.admin);
  assert.equal(balance.status, 200);
  assert.deepEqual(await balance.json(), {
    accountId: ids.accountB,
    balancePaise: '8700',
    currencyCode: 'INR',
  });
});

test('account holder sees only assigned accounts with canView=true', async () => {
  const response = await get('/api/accounts', ids.holder);
  assert.equal(response.status, 200);
  const { accounts: listed } = await response.json();
  assert.deepEqual(listed.map((account) => account.id), [ids.accountA]);

  const allowed = await get(`/api/accounts/${ids.accountA}`, ids.holder);
  assert.equal(allowed.status, 200);
  const denied = await get(`/api/accounts/${ids.accountB}`, ids.holder);
  assert.equal(denied.status, 404);
});

test('holder cannot read an unassigned account or its balance', async () => {
  const detail = await get(`/api/accounts/${ids.accountPrivate}`, ids.holder);
  const balance = await get(`/api/accounts/${ids.accountPrivate}/balance`, ids.holder);
  assert.equal(detail.status, 404);
  assert.equal(balance.status, 404);
});

test('auditor can read assigned customer accounts but has no account write route', async () => {
  const allowed = await get(`/api/accounts/${ids.accountA}`, ids.auditor);
  const clearing = await get(`/api/accounts/${ids.clearing}`, ids.auditor);
  assert.equal(allowed.status, 200);
  assert.equal(clearing.status, 404);

  const write = await fetch(`${baseUrl}/api/accounts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(ids.auditor)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ accountNumber: 'ATTACK', role: 'ADMIN', userId: ids.admin }),
  });
  assert.equal(write.status, 403);
});

test('admin creates a customer account through the controlled database function contract', async () => {
  const response = await fetch(`${baseUrl}/api/accounts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(ids.admin)}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      accountNumber: 'BV-NEW-001',
      accountType: 'PERSONAL',
      holderUserId: ids.holder,
    }),
  });
  assert.equal(response.status, 201);
  const { account } = await response.json();
  assert.equal(account.accountNumber, 'BV-NEW-001');
  assert.equal(account.type, 'PERSONAL');
  assert.equal(account.status, 'ACTIVE');
  assert.equal(account.currencyCode, 'INR');
  assert.equal(Object.hasOwn(account, 'balancePaise'), false);
  assert.equal(createdRecords.length, 1);
  assert.equal(createdRecords[0].actorId, ids.admin);
  assert.deepEqual(createdRecords[0].permission, {
    userId: ids.holder,
    accountId: account.id,
    canView: true,
    canDeposit: false,
    canWithdraw: false,
    canTransfer: false,
  });
  assert.deepEqual(createdRecords[0].audit, {
    actorId: ids.admin,
    action: 'ACCOUNT_CREATED',
    entityId: account.id,
  });
});

test('account creation rejects non-admins before calling the database function', async () => {
  for (const userId of [ids.holder, ids.auditor]) {
    const response = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(userId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accountNumber: 'BV-DENIED', accountType: 'PERSONAL', holderUserId: ids.holder }),
    });
    assert.equal(response.status, 403);
  }
  assert.equal(createdRecords.length, 0);
});

test('account creation validates inputs and prevents body-supplied authority or clearing account types', async () => {
  const payload = { accountNumber: 'BV-VALID', accountType: 'PERSONAL', holderUserId: ids.holder };
  const responses = await Promise.all([
    fetch(`${baseUrl}/api/accounts`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.admin)}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, accountNumber: '  ' }) }),
    fetch(`${baseUrl}/api/accounts`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.admin)}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, accountType: 'SYSTEM_CLEARING' }) }),
    fetch(`${baseUrl}/api/accounts`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.admin)}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, systemCode: 'CLEARING_DEPOSIT_INR' }) }),
    fetch(`${baseUrl}/api/accounts`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.admin)}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, actorId: ids.otherHolder }) }),
  ]);
  assert.ok(responses.every((response) => response.status === 400));
  assert.equal(createdRecords.length, 0);
});

test('duplicate account number returns conflict', async () => {
  const body = { accountNumber: 'BV-DUPLICATE', accountType: 'BUSINESS', holderUserId: ids.holder };
  const headers = { authorization: `Bearer ${tokenFor(ids.admin)}`, 'content-type': 'application/json' };
  const first = await fetch(`${baseUrl}/api/accounts`, { method: 'POST', headers, body: JSON.stringify(body) });
  const duplicate = await fetch(`${baseUrl}/api/accounts`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'Account number is already in use' });
});

test('malformed account IDs return 400 and missing ID routes return 404', async () => {
  const malformed = await get('/api/accounts/not-a-uuid', ids.admin);
  const missing = await get('/api/accounts//balance', ids.admin);
  assert.equal(malformed.status, 400);
  assert.equal(missing.status, 404);
});

test('account routes require authentication', async () => {
  const missing = await get('/api/accounts', ids.admin, null);
  const invalid = await get('/api/accounts', ids.admin, 'bad-token');
  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
});

test('holder cannot spoof identity or role with URL query values', async () => {
  const response = await get(
    `/api/accounts/${ids.accountB}?userId=${ids.otherHolder}&actorId=${ids.otherHolder}&role=ADMIN`,
    ids.holder,
  );
  assert.equal(response.status, 404);
});

test('auditor cannot spoof admin role or another user in query parameters', async () => {
  const response = await get(
    `/api/accounts?userId=${ids.admin}&role=ADMIN`,
    ids.auditor,
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).accounts.map((account) => account.id), [ids.accountA]);
});
