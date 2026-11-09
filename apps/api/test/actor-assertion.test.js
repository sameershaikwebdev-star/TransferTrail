import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActorAssertion, verifyActorAssertion } from '../src/config/actor-assertion.js';

const actorId = 'c0e3e260-5fd0-4bc9-b9da-5748a9c351c7';
const secret = process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY ?? 'ab'.repeat(32);
process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY ??= secret;

test('actor assertions verify only for their actor, action, and exact argument context', () => {
  const context = ['invitation-id', 'AUDITOR'];
  const assertion = createActorAssertion(actorId, 'INVITATION_CREATE', context);
  assert.equal(verifyActorAssertion(actorId, 'INVITATION_CREATE', assertion, context, secret), true);
  assert.equal(verifyActorAssertion(actorId, 'INVITATION_REVOKE', assertion, context, secret), false);
  assert.equal(verifyActorAssertion(actorId, 'INVITATION_CREATE', assertion, ['invitation-id', 'ADMIN'], secret), false);
  assert.equal(verifyActorAssertion('c0e3e260-5fd0-4bc9-b9da-5748a9c351c8', 'INVITATION_CREATE', assertion, context, secret), false);
});

test('actor assertion verification rejects expiration, malformed proofs, and invalid key configuration', () => {
  const context = ['sensitive-operation'];
  const assertion = createActorAssertion(actorId, 'CHANGE_PASSWORD', context);
  assert.equal(verifyActorAssertion(actorId, 'CHANGE_PASSWORD', { ...assertion, issuedAt: assertion.issuedAt - 61 }, context, secret), false);
  assert.equal(verifyActorAssertion(actorId, 'CHANGE_PASSWORD', { ...assertion, signature: 'xyz' }, context, secret), false);
  assert.equal(verifyActorAssertion(actorId, 'CHANGE_PASSWORD', assertion, context, 'zz'), false);

  const previous = process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY;
  delete process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY;
  try {
    assert.throws(() => createActorAssertion(actorId, 'CHANGE_PASSWORD', context), /at least 32 bytes/);
  } finally {
    if (previous === undefined) delete process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY;
    else process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY = previous;
  }
});
