import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import express from 'express';
import jwt from 'jsonwebtoken';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import { createAdminRouter } from '../src/routes/admin.routes.js';
import { JWT_ISSUER, JWT_AUDIENCE } from '../src/config/auth.js';
import { createActorAssertion } from '../src/config/actor-assertion.js';

const adminUrl = process.env.BALANCEVAULT_TEST_DATABASE_URL;
const runtimeUrl = process.env.BALANCEVAULT_TEST_RUNTIME_DATABASE_URL;
for (const url of [adminUrl, runtimeUrl]) {
  if (url && !new URL(url).pathname.endsWith('_test')) throw new Error('Disposable _test database required');
}

test('permission grants and revocations require signed admin scope and record atomic, conflict-safe audit changes', {
  skip: !adminUrl || !runtimeUrl,
}, async () => {
  const admin = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: runtimeUrl });
  await admin.connect();
  await runtime.connect();
  const actor = randomUUID();
  const holder = randomUUID();
  const account = randomUUID();
  const backupHolder = randomUUID();
  const stranger = randomUUID();
  const disabled = [false, false, false];
  const enabled = [true, true, true];
  function values(next, previous, actorId = actor, holderId = holder) {
    const context = [account, holderId, ...next, ...previous];
    const proof = createActorAssertion(actorId, 'ACCOUNT_PERMISSIONS_UPDATE', context);
    return [actorId, ...context, proof.issuedAt, proof.nonce, proof.contextHash, proof.signature];
  }
  const sql = 'SELECT public.set_account_permissions_asserted($1::uuid,$2::uuid,$3::uuid,$4::boolean,$5::boolean,$6::boolean,$7::boolean,$8::boolean,$9::boolean,$10::bigint,$11::uuid,$12::text,$13::text) AS changed';
  const update = (next, previous, actorId = actor, holderId = holder) => runtime.query(sql, values(next, previous, actorId, holderId));
  const auditCount = async () => Number((await admin.query('SELECT count(*) FROM public."AuditLog" WHERE "entityId"=$1 AND action=$2', [account, 'ACCOUNT_PERMISSIONS_UPDATED'])).rows[0].count);
  try {
    await admin.query('BEGIN');
    for (const [id, role] of [[actor, 'ADMIN'], [holder, 'ACCOUNT_HOLDER'], [backupHolder, 'ACCOUNT_HOLDER'], [stranger, 'ACCOUNT_HOLDER']]) {
      await admin.query('INSERT INTO public."User"(id,email,"passwordHash",role,"updatedAt") VALUES($1,$2,$3,$4,now())', [id, id + '@example.test', 'test-only', role]);
    }
    await admin.query('INSERT INTO public."Account"(id,"accountNumber",type,"updatedAt") VALUES($1,$2,$3,now())', [account, account, 'PERSONAL']);
    await admin.query('INSERT INTO public."AccountPermission"(id,"userId","accountId","canView","updatedAt") VALUES($1,$2,$3,true,now())', [randomUUID(), holder, account]);

    await admin.query('INSERT INTO public."AccountPermission"(id,"userId","accountId","canView","updatedAt") VALUES($1,$2,$3,true,now())', [randomUUID(), backupHolder, account]);
    await admin.query('COMMIT');

    await assert.rejects(runtime.query('UPDATE public."AccountPermission" SET "canDeposit"=true WHERE "accountId"=$1', [account]), { code: '42501' });
    await assert.rejects(update(enabled, disabled, holder), { code: '42501' });
    const forged = values(enabled, disabled);
    forged[12] = '00'.repeat(32);
    await assert.rejects(runtime.query(sql, forged), { code: '42501' });
    const tampered = values(enabled, disabled);
    tampered[3] = false;
    await assert.rejects(runtime.query(sql, tampered), { code: '42501' });
    await assert.rejects(update(enabled, disabled, actor, stranger), { code: 'P0002' });
    assert.equal(await auditCount(), 0);

    assert.equal((await update(enabled, disabled)).rows[0].changed, true);
    assert.equal(await auditCount(), 1);
    const audit = (await admin.query('SELECT "actorId",metadata FROM public."AuditLog" WHERE "entityId"=$1', [account])).rows[0];
    assert.equal(audit.actorId, actor);
    assert.deepEqual(audit.metadata.previous, { canDeposit: false, canWithdraw: false, canTransfer: false });
    assert.deepEqual(audit.metadata.current, { canDeposit: true, canWithdraw: true, canTransfer: true });
    assert.equal((await update(enabled, enabled)).rows[0].changed, false);
    assert.equal(await auditCount(), 1);
    await assert.rejects(update(disabled, disabled), { code: '40001' });
    assert.equal(await auditCount(), 1);

    await admin.query('UPDATE public."User" SET "isActive"=false WHERE id=$1', [holder]);
    await assert.rejects(update(disabled, enabled), { code: '22023' });
    await admin.query('UPDATE public."User" SET "isActive"=true WHERE id=$1', [holder]);
    await admin.query('UPDATE public."Account" SET status=$2 WHERE id=$1', [account, 'FROZEN']);
    await assert.rejects(update(disabled, enabled), { code: '22023' });
    await admin.query('UPDATE public."Account" SET status=$2 WHERE id=$1', [account, 'ACTIVE']);

    assert.equal((await update(disabled, enabled)).rows[0].changed, true);
    const saved = (await admin.query('SELECT "canDeposit","canWithdraw","canTransfer" FROM public."AccountPermission" WHERE "accountId"=$1', [account])).rows[0];
    assert.deepEqual(saved, { canDeposit: false, canWithdraw: false, canTransfer: false });
    assert.equal(await auditCount(), 2);
    const consumed = values(enabled, disabled);
    await runtime.query(sql, consumed);
    await assert.rejects(runtime.query(sql, consumed), { code: '42501' });
    const competingRuntime = new Client({ connectionString: runtimeUrl });
    await competingRuntime.connect();
    try {
      const results = await Promise.allSettled([
        update([false, true, true], enabled),
        competingRuntime.query(sql, values([true, false, true], enabled)),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.find((result) => result.status === 'rejected').reason.code, '40001');
    } finally {
      await competingRuntime.end();
    }

    process.env.JWT_ACCESS_SECRET ||= 'permissions-integration-test-secret-0123456789';
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl }) });
    const app = express();
    app.use(express.json());
    app.use('/api/admin', createAdminRouter(prisma));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const token = jwt.sign({ ver: 0 }, process.env.JWT_ACCESS_SECRET, {
        algorithm: 'HS256', subject: actor, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: '5m',
      });
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const url = `http://127.0.0.1:${server.address().port}/api/admin/accounts/${account}/permissions`;
      const read = await fetch(url, { headers });
      assert.equal(read.status, 200);
      const rows = (await read.json()).permissions;
      const current = rows.find((row) => row.userId === holder);
      const expected = { canDeposit: current.canDeposit, canWithdraw: current.canWithdraw, canTransfer: current.canTransfer };
      const body = JSON.stringify({ canDeposit: false, canWithdraw: false, canTransfer: false, expected });
      const response = await fetch(`${url}/${holder}`, { method: 'PATCH', headers, body });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).changed, true);
      const stale = await fetch(`${url}/${holder}`, { method: 'PATCH', headers, body });
      assert.equal(stale.status, 409);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await prisma.$disconnect();
    }

    await admin.query('UPDATE public."User" SET "isActive"=false WHERE id=$1', [actor]);
    await assert.rejects(update(disabled, enabled), { code: '42501' });
  } finally {
    await runtime.end();
    await admin.end();
  }
});
