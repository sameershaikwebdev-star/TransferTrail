import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';

const { Client } = pg;
// This suite owns a separate disposable database because the first-admin
// invariant must be tested against an empty User table without other test files
// concurrently creating administrator fixtures.
const adminUrl = process.env.BALANCEVAULT_TEST_PROVISIONING_DATABASE_URL;
const runtimeUrl = process.env.BALANCEVAULT_TEST_PROVISIONING_RUNTIME_DATABASE_URL;
const bootstrapUrl = process.env.BALANCEVAULT_TEST_PROVISIONING_BOOTSTRAP_DATABASE_URL;
const databaseName = adminUrl ? new URL(adminUrl).pathname.slice(1) : '';
const enabled = Boolean(adminUrl && runtimeUrl && bootstrapUrl);
const actorKeyHex = process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY ?? 'ef'.repeat(32);
if (enabled && (!databaseName.endsWith('_test') || databaseName === 'balancevault_dev'
  || new URL(runtimeUrl).pathname.slice(1) !== databaseName
  || new URL(bootstrapUrl).pathname.slice(1) !== databaseName)) {
  throw new Error('Privileged provisioning tests require URLs for the same disposable *_test database.');
}

let admin;
let runtime;
let bootstrap;

async function connect(url, role = null) {
  const client = new Client({ connectionString: url });
  await client.connect();
  const { rows: [row] } = await client.query('SELECT current_database() AS database_name');
  assert.equal(row.database_name, databaseName);
  if (role) await client.query(`SET ROLE ${role}`);
  return client;
}

function tokenHash(token) { return createHash('sha256').update(token, 'utf8').digest('hex'); }
function newToken() { return randomBytes(32).toString('base64url'); }
function actorProof(actorId, action, issuedAt = Math.floor(Date.now() / 1000)) {
  const nonce = randomUUID();
  return {
    issuedAt,
    nonce,
    sign(context) {
      const canonical = context.map((value) => {
        const text = String(value);
        return `${Buffer.byteLength(text, 'utf8')}:${text}`;
      }).join('|');
      const contextHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
      const signature = createHmac('sha256', Buffer.from(actorKeyHex, 'hex'))
        .update(`v1|${actorId.toLowerCase()}|${action}|${issuedAt}|${nonce}|${contextHash}`)
        .digest('hex');
      return { contextHash, signature };
    },
  };
}

async function invite(actorId, role, token = newToken(), expiresAt = new Date(Date.now() + 60 * 60 * 1000)) {
  const id = randomUUID();
  const email = `${id}@example.test`;
  const fullName = 'Provisioned Person';
  const hashedToken = tokenHash(token);
  const proof = actorProof(actorId, 'INVITATION_CREATE');
  const signed = proof.sign([id, fullName, email, role, hashedToken, expiresAt.getTime()]);
  const result = await runtime.query(
    'SELECT * FROM public.create_privileged_user_invitation_asserted($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7::timestamptz,$8::bigint,$9::bigint,$10::uuid,$11::text,$12::text)',
    [actorId, id, fullName, email, role, hashedToken, expiresAt, expiresAt.getTime(), proof.issuedAt, proof.nonce, signed.contextHash, signed.signature],
  );
  return { id, email, token, proof: { ...proof, ...signed }, expiresAt, ...result.rows[0] };
}

before(async () => {
  if (!enabled) return;
  admin = await connect(adminUrl);
  runtime = await connect(runtimeUrl, 'balancevault_runtime');
  bootstrap = await connect(bootstrapUrl, 'balancevault_bootstrap_operator');
  await admin.query('SET ROLE balancevault_auth_owner');
  await admin.query(
    `INSERT INTO balancevault_auth_private.actor_assertion_key (singleton, secret)
     VALUES (true, $1) ON CONFLICT (singleton) DO UPDATE SET secret=EXCLUDED.secret`,
    [Buffer.from(actorKeyHex, 'hex')],
  );
  await admin.query('RESET ROLE');
});
after(async () => {
  await Promise.all([runtime?.end(), bootstrap?.end(), admin?.end()].filter(Boolean));
});

test('first-admin bootstrap is one-time, atomic under concurrency, and password is bcrypt hashed', { skip: !enabled }, async () => {
  await assert.rejects(
    bootstrap.query('SELECT * FROM public.bootstrap_first_admin($1,$2,$3,$4)', [randomUUID(), 'Invalid Candidate', `${randomUUID()}@example.test`, 'not-a-bcrypt-hash']),
    (error) => error.code === '22023',
  );
  assert.equal((await admin.query('SELECT count(*) FROM public."PrivilegedBootstrap"')).rows[0].count, '0');
  const tasks = [0, 1].map(async () => {
    const client = await connect(bootstrapUrl, 'balancevault_bootstrap_operator');
    try {
      const id = randomUUID();
      const email = `${id}@example.test`;
      const password = 'first-admin-test-password';
      const passwordHash = await bcrypt.hash(password, 10);
      const result = await client.query(
        'SELECT * FROM public.bootstrap_first_admin($1,$2,$3,$4)',
        [id, 'Disposable First Admin', email, passwordHash],
      );
      return { id, email, password, passwordHash, row: result.rows[0] };
    } finally { await client.end(); }
  });
  const outcomes = await Promise.allSettled(tasks);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  const success = outcomes.find((outcome) => outcome.status === 'fulfilled').value;
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected').reason;
  assert.equal(rejected.code, '55000');
  assert.equal(success.row.role, 'ADMIN');
  assert.equal(success.row.isActive, true);
  assert.equal(Object.hasOwn(success.row, 'passwordHash'), false);
  const stored = await admin.query('SELECT "passwordHash" FROM public."User" WHERE id=$1', [success.id]);
  assert.equal(await bcrypt.compare(success.password, stored.rows[0].passwordHash), true);
  assert.equal(stored.rows[0].passwordHash, success.passwordHash);
  assert.equal((await admin.query('SELECT count(*) FROM public."PrivilegedBootstrap"')).rows[0].count, '1');
  assert.equal((await admin.query(`SELECT count(*) FROM public."AuditLog" WHERE action='FIRST_ADMIN_BOOTSTRAPPED'`)).rows[0].count, '1');
});

test('bootstrap grants are isolated from runtime and PUBLIC', { skip: !enabled }, async () => {
  const { rows: [r] } = await admin.query(`
    SELECT
      has_function_privilege('balancevault_runtime','public.bootstrap_first_admin(uuid,text,text,text)','EXECUTE') AS runtime_exec,
      has_function_privilege('balancevault_bootstrap_operator','public.bootstrap_first_admin(uuid,text,text,text)','EXECUTE') AS operator_exec,
      has_function_privilege('balancevault_runtime','public.create_privileged_user_invitation_asserted(uuid,uuid,text,text,public."UserRole",character,timestamp with time zone,bigint,bigint,uuid,text,text)','EXECUTE') AS runtime_invite_exec,
      has_function_privilege('balancevault_runtime','public.revoke_privileged_user_invitation_asserted(uuid,uuid,bigint,uuid,text,text)','EXECUTE') AS runtime_revoke_exec,
      has_function_privilege('balancevault_runtime','public.create_privileged_user_invitation(uuid,uuid,text,text,public."UserRole",character,timestamp with time zone)','EXECUTE') AS runtime_legacy_invite_exec,
      has_function_privilege('balancevault_runtime','public.change_user_password(uuid,integer,text)','EXECUTE') AS runtime_legacy_password_exec,
      has_function_privilege('balancevault_runtime','public.change_user_password_asserted(uuid,integer,text,bigint,uuid,text,text)','EXECUTE') AS runtime_password_exec,
      has_function_privilege('balancevault_runtime','public.accept_privileged_user_invitation(uuid,character,text)','EXECUTE') AS runtime_accept_exec,
      has_function_privilege('balancevault_bootstrap_operator','public.create_privileged_user_invitation_asserted(uuid,uuid,text,text,public."UserRole",character,timestamp with time zone,bigint,bigint,uuid,text,text)','EXECUTE') AS operator_invite_exec,
      has_function_privilege('balancevault_runtime','balancevault_auth_private.consume_actor_assertion(uuid,text,bigint,uuid,text,text)','EXECUTE') AS runtime_assertion_helper_exec,
      has_function_privilege('balancevault_auth_owner','balancevault_auth_private.consume_actor_assertion(uuid,text,bigint,uuid,text,text)','EXECUTE') AS auth_owner_assertion_helper_exec,
      has_schema_privilege('balancevault_runtime','balancevault_auth_private','USAGE') AS runtime_auth_private_usage,
      NOT EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid IN (
          'public.bootstrap_first_admin(uuid,text,text,text)'::regprocedure,
          'public.create_privileged_user_invitation_asserted(uuid,uuid,text,text,public."UserRole",character,timestamp with time zone,bigint,bigint,uuid,text,text)'::regprocedure,
          'public.revoke_privileged_user_invitation_asserted(uuid,uuid,bigint,uuid,text,text)'::regprocedure,
          'public.change_user_password_asserted(uuid,integer,text,bigint,uuid,text,text)'::regprocedure,
          'balancevault_auth_private.consume_actor_assertion(uuid,text,bigint,uuid,text,text)'::regprocedure,
          'public.create_privileged_user_invitation(uuid,uuid,text,text,public."UserRole",character,timestamp with time zone)'::regprocedure,
          'public.revoke_privileged_user_invitation(uuid,uuid)'::regprocedure,
          'public.change_user_password(uuid,integer,text)'::regprocedure,
          'public.accept_privileged_user_invitation(uuid,character,text)'::regprocedure
        ) AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_revoked,
      (SELECT pg_get_userbyid(proowner)='balancevault_provisioning_owner' AND prosecdef
        AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] FROM pg_proc
        WHERE oid='public.bootstrap_first_admin(uuid,text,text,text)'::regprocedure) AS owner_safe,
      (SELECT count(*) FROM pg_proc p WHERE p.oid IN (
        'public.create_privileged_user_invitation(uuid,uuid,text,text,public."UserRole",character,timestamp with time zone)'::regprocedure,
        'public.revoke_privileged_user_invitation(uuid,uuid)'::regprocedure,
        'public.accept_privileged_user_invitation(uuid,character,text)'::regprocedure
      ) AND pg_get_userbyid(p.proowner)='balancevault_provisioning_owner' AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) AS secure_invitation_functions,
      (SELECT count(*) FROM pg_proc p WHERE p.oid IN (
        'public.create_privileged_user_invitation_asserted(uuid,uuid,text,text,public."UserRole",character,timestamp with time zone,bigint,bigint,uuid,text,text)'::regprocedure,
        'public.revoke_privileged_user_invitation_asserted(uuid,uuid,bigint,uuid,text,text)'::regprocedure
      ) AND pg_get_userbyid(p.proowner)='balancevault_provisioning_owner' AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) AS secure_asserted_functions,
      pg_has_role('balancevault_migration_owner','balancevault_provisioning_owner','MEMBER') AS migration_can_set_owner,
      (SELECT NOT rolcanlogin AND NOT rolinherit FROM pg_roles WHERE rolname='balancevault_provisioning_owner') AS owner_restricted,
      has_column_privilege('balancevault_provisioning_owner','public."User"','passwordHash','INSERT') AS owner_can_insert_hash,
      has_column_privilege('balancevault_provisioning_owner','public."User"','passwordHash','SELECT') AS owner_can_read_hash,
      has_table_privilege('balancevault_provisioning_owner','public."User"','UPDATE') AS owner_can_update_user,
      has_column_privilege('balancevault_provisioning_owner','public."UserInvitation"','acceptedAt','UPDATE') AS owner_can_mark_accepted,
      has_column_privilege('balancevault_provisioning_owner','public."UserInvitation"','tokenHash','UPDATE') AS owner_can_change_hash,
      pg_has_role('balancevault_runtime','balancevault_bootstrap_operator','MEMBER') AS runtime_is_operator
  `);
  assert.equal(r.runtime_exec, false);
  assert.equal(r.operator_exec, true);
  assert.equal(r.public_revoked, true);
  assert.equal(r.owner_safe, true);
  assert.equal(Number(r.secure_invitation_functions), 3);
  assert.equal(Number(r.secure_asserted_functions), 2);
  assert.equal(r.migration_can_set_owner, true);
  assert.equal(r.owner_restricted, true);
  assert.equal(r.owner_can_insert_hash, true);
  assert.equal(r.owner_can_read_hash, false);
  assert.equal(r.owner_can_update_user, false);
  assert.equal(r.owner_can_mark_accepted, true);
  assert.equal(r.owner_can_change_hash, false);
  assert.equal(r.runtime_is_operator, false);
  assert.equal(r.runtime_invite_exec, true);
  assert.equal(r.runtime_revoke_exec, true);
  assert.equal(r.runtime_legacy_invite_exec, false);
  assert.equal(r.runtime_legacy_password_exec, false);
  assert.equal(r.runtime_password_exec, true);
  assert.equal(r.operator_invite_exec, false);
  assert.equal(r.runtime_assertion_helper_exec, false);
  assert.equal(r.auth_owner_assertion_helper_exec, true);
  assert.equal(r.runtime_auth_private_usage, false);
  assert.equal(r.runtime_accept_exec, true);
  assert.equal((await admin.query(`SELECT has_column_privilege('balancevault_runtime','public."UserInvitation"','tokenHash','SELECT') AS can_read_hash`)).rows[0].can_read_hash, false);
  for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    assert.equal((await admin.query(`SELECT has_table_privilege('balancevault_runtime','public."UserInvitation"',$1) AS can_write`, [privilege])).rows[0].can_write, false);
  }
  await assert.rejects(runtime.query('SELECT * FROM public.bootstrap_first_admin($1,$2,$3,$4)', [randomUUID(), 'No', `${randomUUID()}@example.test`, 'x']), (error) => error.code === '42501');
  await assert.rejects(bootstrap.query(`INSERT INTO public."User" (id,email,"passwordHash") VALUES ($1,$2,'x')`, [randomUUID(), `${randomUUID()}@example.test`]), (error) => error.code === '42501');
  await assert.rejects(runtime.query('SELECT "tokenHash" FROM public."UserInvitation" LIMIT 1'), (error) => error.code === '42501');
});

test('invitation lifecycle enforces issuer role, allowed roles, revocation, expiry, one-time acceptance and password hashing', { skip: !enabled }, async () => {
  const { rows: [adminUser] } = await admin.query(`SELECT "adminUserId" FROM public."PrivilegedBootstrap" WHERE id=true`);
  const adminId = adminUser.adminUserId;
  const badActor = randomUUID();
  const holderHash = await bcrypt.hash('ordinary-holder-password', 10);
  await runtime.query('SELECT * FROM public.create_account_holder_profile($1,$2,$3,$4)', [badActor, 'Ordinary Holder', `${badActor}@example.test`, holderHash]);
  await assert.rejects(invite(badActor, 'AUDITOR'), (error) => error.code === '42501');
  const spoofId = randomUUID();
  const spoofEmail = `${spoofId}@example.test`;
  const spoofHash = 'a'.repeat(64);
  const spoofExpiry = new Date(Date.now() + 3600000);
  const spoofContext = [spoofId, 'Spoof Attempt', spoofEmail, 'AUDITOR', spoofHash, spoofExpiry.getTime()];
  const wrongActorProof = actorProof(badActor, 'INVITATION_CREATE');
  const wrongActorSigned = wrongActorProof.sign(spoofContext);
  await assert.rejects(
    runtime.query(
      'SELECT * FROM public.create_privileged_user_invitation_asserted($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7,$8::bigint,$9::bigint,$10::uuid,$11::text,$12::text)',
      [adminId, spoofId, 'Spoof Attempt', spoofEmail, 'AUDITOR', spoofHash, spoofExpiry, spoofExpiry.getTime(), wrongActorProof.issuedAt, wrongActorProof.nonce, wrongActorSigned.contextHash, wrongActorSigned.signature],
    ),
    (error) => error.code === '42501',
    'a runtime caller cannot substitute an administrator UUID for an assertion signed for a different actor',
  );
  await assert.rejects(
    runtime.query('SELECT * FROM public.create_privileged_user_invitation($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7)', [adminId, randomUUID(), 'Legacy', `${randomUUID()}@example.test`, 'AUDITOR', 'a'.repeat(64), new Date(Date.now() + 3600000)]),
    (error) => error.code === '42501',
  );

  const assertionId = randomUUID();
  const assertionToken = newToken();
  const assertionEmail = `${assertionId}@example.test`;
  const assertionExpiry = new Date(Date.now() + 60 * 60 * 1000);
  const assertionHash = tokenHash(assertionToken);
  const assertionContext = [assertionId, 'Assertion Test', assertionEmail, 'AUDITOR', assertionHash, assertionExpiry.getTime()];
  const argumentProof = actorProof(adminId, 'INVITATION_CREATE');
  const argumentSigned = argumentProof.sign([...assertionContext.slice(0, 3), 'ADMIN', ...assertionContext.slice(4)]);
  await assert.rejects(
    runtime.query(
      'SELECT * FROM public.create_privileged_user_invitation_asserted($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7,$8::bigint,$9::bigint,$10::uuid,$11::text,$12::text)',
      [adminId, assertionId, 'Assertion Test', assertionEmail, 'AUDITOR', assertionHash, assertionExpiry, assertionExpiry.getTime(), argumentProof.issuedAt, argumentProof.nonce, argumentSigned.contextHash, argumentSigned.signature],
    ),
    (error) => error.code === '42501',
    'changing an operation argument invalidates its assertion',
  );

  const wrongActionProof = actorProof(adminId, 'INVITATION_REVOKE');
  const wrongActionSigned = wrongActionProof.sign(assertionContext);
  await assert.rejects(
    runtime.query(
      'SELECT * FROM public.create_privileged_user_invitation_asserted($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7,$8::bigint,$9::bigint,$10::uuid,$11::text,$12::text)',
      [adminId, assertionId, 'Assertion Test', assertionEmail, 'AUDITOR', assertionHash, assertionExpiry, assertionExpiry.getTime(), wrongActionProof.issuedAt, wrongActionProof.nonce, wrongActionSigned.contextHash, wrongActionSigned.signature],
    ),
    (error) => error.code === '42501',
    'assertions are bound to their action',
  );

  const expiredProof = actorProof(adminId, 'INVITATION_CREATE', Math.floor(Date.now() / 1000) - 61);
  const expiredSigned = expiredProof.sign(assertionContext);
  await assert.rejects(
    runtime.query(
      'SELECT * FROM public.create_privileged_user_invitation_asserted($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7,$8::bigint,$9::bigint,$10::uuid,$11::text,$12::text)',
      [adminId, assertionId, 'Assertion Test', assertionEmail, 'AUDITOR', assertionHash, assertionExpiry, assertionExpiry.getTime(), expiredProof.issuedAt, expiredProof.nonce, expiredSigned.contextHash, expiredSigned.signature],
    ),
    (error) => error.code === '42501',
    'expired assertions are rejected',
  );

  const malformedProof = actorProof(adminId, 'INVITATION_CREATE');
  const malformedSigned = malformedProof.sign(assertionContext);
  await assert.rejects(
    runtime.query(
      'SELECT * FROM public.create_privileged_user_invitation_asserted($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7,$8::bigint,$9::bigint,$10::uuid,$11::text,$12::text)',
      [adminId, assertionId, 'Assertion Test', assertionEmail, 'AUDITOR', assertionHash, assertionExpiry, assertionExpiry.getTime(), malformedProof.issuedAt, malformedProof.nonce, malformedSigned.contextHash, 'g'.repeat(64)],
    ),
    (error) => error.code === '42501',
    'malformed signatures are rejected',
  );

  const [assertionKey] = (await admin.query('SELECT secret FROM balancevault_auth_private.actor_assertion_key WHERE singleton=true')).rows;
  await admin.query('DELETE FROM balancevault_auth_private.actor_assertion_key WHERE singleton=true');
  try {
    const unavailableProof = actorProof(adminId, 'INVITATION_CREATE');
    const unavailableSigned = unavailableProof.sign(assertionContext);
    await assert.rejects(
      runtime.query(
        'SELECT * FROM public.create_privileged_user_invitation_asserted($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7,$8::bigint,$9::bigint,$10::uuid,$11::text,$12::text)',
        [adminId, assertionId, 'Assertion Test', assertionEmail, 'AUDITOR', assertionHash, assertionExpiry, assertionExpiry.getTime(), unavailableProof.issuedAt, unavailableProof.nonce, unavailableSigned.contextHash, unavailableSigned.signature],
      ),
      (error) => error.code === '55000',
      'the database fails closed when the assertion key is missing',
    );
  } finally {
    await admin.query('INSERT INTO balancevault_auth_private.actor_assertion_key(singleton,secret) VALUES(true,$1)', [assertionKey.secret]);
  }

  const concurrentId = randomUUID();
  const concurrentEmail = `${concurrentId}@example.test`;
  const concurrentExpiry = new Date(Date.now() + 60 * 60 * 1000);
  const concurrentHash = tokenHash(newToken());
  const concurrentContext = [concurrentId, 'Concurrent Assertion Test', concurrentEmail, 'AUDITOR', concurrentHash, concurrentExpiry.getTime()];
  const concurrentProof = actorProof(adminId, 'INVITATION_CREATE');
  const concurrentSigned = concurrentProof.sign(concurrentContext);
  const concurrentArgs = [adminId, concurrentId, 'Concurrent Assertion Test', concurrentEmail, 'AUDITOR', concurrentHash,
    concurrentExpiry, concurrentExpiry.getTime(), concurrentProof.issuedAt, concurrentProof.nonce,
    concurrentSigned.contextHash, concurrentSigned.signature];
  const secondRuntime = await connect(runtimeUrl, 'balancevault_runtime');
  let invitationCreated = false;
  try {
    // Hold both independent sessions at a JS barrier, then release both query
    // submissions together. Separate pg.Client instances allow PostgreSQL to
    // execute the statements concurrently instead of queueing them client-side.
    let readyCount = 0;
    let release;
    const start = new Promise((resolve) => { release = resolve; });
    const submit = async (client) => {
      readyCount += 1;
      if (readyCount === 2) release();
      await start;
      try {
        return { result: await client.query(
          'SELECT * FROM public.create_privileged_user_invitation_asserted($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7,$8::bigint,$9::bigint,$10::uuid,$11::text,$12::text)',
          concurrentArgs,
        ) };
      } catch (error) { return { error }; }
    };
    const outcomes = await Promise.all([submit(runtime), submit(secondRuntime)]);
    const successes = outcomes.filter(({ result }) => result);
    const failures = outcomes.filter(({ error }) => error);
    invitationCreated = successes.length > 0;
    assert.equal(successes.length, 1, outcomes.map(({ error }) => error && `${error.code}: ${error.message}`).filter(Boolean).join('\n'));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].error.code, '42501', failures[0].error.message);
    assert.match(failures[0].error.message, /assertion has already been used/i);

    await assert.rejects(
      secondRuntime.query(
        'SELECT * FROM public.create_privileged_user_invitation_asserted($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7,$8::bigint,$9::bigint,$10::uuid,$11::text,$12::text)',
        concurrentArgs,
      ),
      (error) => error.code === '42501' && /assertion has already been used/i.test(error.message),
      'the winning nonce cannot be reused after the concurrent request commits',
    );
  } finally {
    try {
      if (invitationCreated) {
        const cleanupProof = actorProof(adminId, 'INVITATION_REVOKE');
        const cleanupSigned = cleanupProof.sign([concurrentId]);
        await runtime.query(
          'SELECT public.revoke_privileged_user_invitation_asserted($1,$2,$3,$4,$5,$6)',
          [adminId, concurrentId, cleanupProof.issuedAt, cleanupProof.nonce, cleanupSigned.contextHash, cleanupSigned.signature],
        );
      }
    } finally {
      await secondRuntime.end();
    }
  }
  const concurrentAuditEvents = await admin.query(
    `SELECT action, "entityType", "entityId", metadata
       FROM public."AuditLog"
      WHERE "entityId"=$1
        AND action IN ('PRIVILEGED_USER_INVITATION_CREATED','PRIVILEGED_USER_INVITATION_REVOKED')
      ORDER BY "createdAt", id`,
    [concurrentId],
  );
  assert.deepEqual(concurrentAuditEvents.rows.map(({ action }) => action), [
    'PRIVILEGED_USER_INVITATION_CREATED',
    'PRIVILEGED_USER_INVITATION_REVOKED',
  ]);
  for (const event of concurrentAuditEvents.rows) {
    assert.equal(event.entityType, 'UserInvitation');
    assert.equal(event.entityId, concurrentId);
    assert.equal(event.metadata.role, 'AUDITOR');
  }

  const revoked = await invite(adminId, 'AUDITOR');
  const replayContext = [revoked.id, 'Provisioned Person', revoked.email, 'AUDITOR', tokenHash(revoked.token), revoked.expiresAt.getTime()];
  const replaySigned = revoked.proof.sign(replayContext);
  await assert.rejects(
    runtime.query(
      'SELECT * FROM public.create_privileged_user_invitation_asserted($1,$2,$3,$4,$5::public."UserRole",$6::char(64),$7::timestamptz,$8::bigint,$9::bigint,$10::uuid,$11::text,$12::text)',
      [adminId, revoked.id, 'Provisioned Person', revoked.email, 'AUDITOR', tokenHash(revoked.token), revoked.expiresAt, revoked.expiresAt.getTime(), revoked.proof.issuedAt, revoked.proof.nonce, replaySigned.contextHash, replaySigned.signature],
    ),
    (error) => error.code === '42501',
    'API actor assertions are single-use',
  );
  const revokeProof = actorProof(adminId, 'INVITATION_REVOKE');
  const revokeSigned = revokeProof.sign([revoked.id]);
  const revoke = await runtime.query('SELECT public.revoke_privileged_user_invitation_asserted($1,$2,$3,$4,$5,$6) AS changed', [adminId, revoked.id, revokeProof.issuedAt, revokeProof.nonce, revokeSigned.contextHash, revokeSigned.signature]);
  assert.equal(revoke.rows[0].changed, true);
  const revokedAttempt = await runtime.query('SELECT * FROM public.accept_privileged_user_invitation($1,$2::char(64),$3)', [randomUUID(), tokenHash(revoked.token), await bcrypt.hash('revoked-password-value', 10)]).catch((error) => error);
  assert.equal(revokedAttempt.code, 'P0002');

  const expiredToken = newToken();
  const expiredId = randomUUID();
  await admin.query(
    `INSERT INTO public."UserInvitation" (id,"fullName",email,role,"tokenHash","createdByUserId","expiresAt","createdAt")
     VALUES ($1,'Expired Invite',$2,'AUDITOR',$3,$4,clock_timestamp()-interval '1 second',clock_timestamp()-interval '1 day')`,
    [expiredId, `${expiredId}@example.test`, tokenHash(expiredToken), adminId],
  );
  const expired = await runtime.query('SELECT * FROM public.accept_privileged_user_invitation($1,$2::char(64),$3)', [randomUUID(), tokenHash(expiredToken), await bcrypt.hash('expired-password-value', 10)]).catch((error) => error);
  assert.equal(expired.code, 'P0002');

  const pending = await invite(adminId, 'ADMIN');
  const hash = await bcrypt.hash('new-provisioned-admin-password', 10);
  const acceptors = await Promise.all([0, 1].map(async () => {
    const client = await connect(runtimeUrl, 'balancevault_runtime');
    try { return await client.query('SELECT * FROM public.accept_privileged_user_invitation($1,$2::char(64),$3)', [randomUUID(), tokenHash(pending.token), hash]); }
    catch (error) { return error; }
    finally { await client.end(); }
  }));
  const accepted = acceptors.filter((row) => !(row instanceof Error));
  const rejected = acceptors.filter((row) => row instanceof Error);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].code, 'P0002');
  assert.equal(accepted[0].rows[0].role, 'ADMIN');
  assert.equal(Object.hasOwn(accepted[0].rows[0], 'passwordHash'), false);
  const storedUser = await admin.query('SELECT "passwordHash",role FROM public."User" WHERE id=$1', [accepted[0].rows[0].id]);
  assert.equal(storedUser.rows[0].role, 'ADMIN');
  assert.equal(await bcrypt.compare('new-provisioned-admin-password', storedUser.rows[0].passwordHash), true);
  const storedInvite = await admin.query('SELECT "tokenHash","acceptedAt" FROM public."UserInvitation" WHERE id=$1', [pending.id]);
  assert.equal(storedInvite.rows[0].tokenHash, tokenHash(pending.token));
  assert.ok(storedInvite.rows[0].acceptedAt);
  assert.notEqual(storedInvite.rows[0].tokenHash, pending.token);
  const auditorInvite = await invite(adminId, 'AUDITOR');
  const auditorPassword = 'new-provisioned-auditor-password';
  const auditorHash = await bcrypt.hash(auditorPassword, 10);
  const auditorAccepted = await runtime.query('SELECT * FROM public.accept_privileged_user_invitation($1,$2::char(64),$3)', [randomUUID(), tokenHash(auditorInvite.token), auditorHash]);
  assert.equal(auditorAccepted.rows[0].role, 'AUDITOR');
  assert.equal(await bcrypt.compare(auditorPassword, (await admin.query('SELECT "passwordHash" FROM public."User" WHERE id=$1', [auditorAccepted.rows[0].id])).rows[0].passwordHash), true);
  await runtime.query('SELECT public.admin_set_user_active($1,$2,false)', [accepted[0].rows[0].id, adminId]);
  await assert.rejects(invite(adminId, 'AUDITOR'), (error) => error.code === '42501', 'inactive issuers cannot provision privileged users');
  assert.equal((await admin.query(`SELECT count(*) FROM public."AuditLog" WHERE action IN ('PRIVILEGED_USER_INVITATION_CREATED','PRIVILEGED_USER_INVITATION_REVOKED','PRIVILEGED_USER_INVITATION_ACCEPTED','PRIVILEGED_ROLE_PROVISIONED')`)).rows[0].count, '10');
});
