import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const keyPattern = /^(?:[a-f0-9]{2}){32,}$/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseKey(encoded) {
  if (typeof encoded !== 'string' || !keyPattern.test(encoded)) return null;
  return Buffer.from(encoded, 'hex');
}

function getKey() {
  const key = parseKey(process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY);
  if (!key) {
    throw new Error('BALANCEVAULT_ACTOR_ASSERTION_KEY must be at least 32 bytes encoded as hex');
  }
  return key;
}

function contextHash(context) {
  const canonical = context.map((value) => {
    const text = String(value);
    return `${Buffer.byteLength(text, 'utf8')}:${text}`;
  }).join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function payload(actorId, action, issuedAt, nonce, fingerprint) {
  return `v1|${actorId.toLowerCase()}|${action}|${issuedAt}|${nonce.toLowerCase()}|${fingerprint}`;
}

export function createActorAssertion(actorId, action, context) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const fingerprint = contextHash(context);
  const signature = createHmac('sha256', getKey())
    .update(payload(actorId, action, issuedAt, nonce, fingerprint), 'utf8')
    .digest('hex');
  return { issuedAt, nonce, contextHash: fingerprint, signature };
}

export function verifyActorAssertion(actorId, action, assertion, context, secretHex = process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY) {
  const key = parseKey(secretHex);
  if (!key || !uuidPattern.test(actorId ?? '') || typeof action !== 'string'
    || !assertion || !Number.isSafeInteger(assertion.issuedAt)
    || !uuidPattern.test(assertion.nonce ?? '')
    || !/^[a-f0-9]{64}$/i.test(assertion.contextHash ?? '')
    || !/^[a-f0-9]{64}$/i.test(assertion.signature ?? '')) return false;
  const now = Math.floor(Date.now() / 1000);
  if (assertion.issuedAt < now - 60 || assertion.issuedAt > now + 5) return false;
  let fingerprint;
  try {
    fingerprint = contextHash(context);
  } catch {
    return false;
  }
  const expected = createHmac('sha256', key)
    .update(payload(actorId, action, assertion.issuedAt, assertion.nonce, fingerprint), 'utf8')
    .digest();
  const actual = Buffer.from(assertion.signature ?? '', 'hex');
  const suppliedFingerprint = Buffer.from(assertion.contextHash, 'hex');
  const expectedFingerprint = Buffer.from(fingerprint, 'hex');
  return timingSafeEqual(suppliedFingerprint, expectedFingerprint)
    && actual.length === expected.length && timingSafeEqual(actual, expected);
}
