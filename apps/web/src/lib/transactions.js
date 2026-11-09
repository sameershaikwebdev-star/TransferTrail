export const MAX_TRANSACTION_PAISE = BigInt(Number.MAX_SAFE_INTEGER);
const amountPattern = /^(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function parseInrToPaise(value) {
  const input = String(value).trim();
  if (!input || input.length > 24 || !amountPattern.test(input)) {
    throw new Error('Enter a valid INR amount with no more than two decimal places.');
  }

  const [wholePart, fractionalPart = ''] = input.split('.');
  const paise = BigInt(wholePart) * 100n + BigInt(fractionalPart.padEnd(2, '0') || '0');
  if (paise <= 0n) throw new Error('Amount must be greater than ₹0.00.');
  if (paise > MAX_TRANSACTION_PAISE) throw new Error('Amount exceeds the supported transaction limit.');
  return paise.toString();
}

export function formatPaiseForInput(value) {
  const paise = BigInt(value);
  const negative = paise < 0n;
  const absolute = negative ? -paise : paise;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function transactionPayloadKey(payload) {
  return JSON.stringify([
    payload.type,
    payload.accountId ?? null,
    payload.sourceAccountId ?? null,
    payload.destinationAccountId ?? null,
    String(payload.amountPaise),
  ]);
}

export function createTransactionAttempt(previous, payload, idFactory = () => globalThis.crypto.randomUUID()) {
  const payloadKey = transactionPayloadKey(payload);
  if (previous?.payloadKey === payloadKey && previous?.idempotencyKey) return previous;
  return {
    idempotencyKey: idFactory(),
    payload,
    payloadKey,
    state: 'review',
  };
}

export function transactionStorageKey(userId, type) {
  return `balancevault.pending-transaction.v1:${userId}:${type}`;
}

export function readPendingTransaction(userId, type, storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(transactionStorageKey(userId, type)) || 'null');
    if (!value || !uuidPattern.test(value.idempotencyKey ?? '') || !value.payload
      || value.payload.type !== type || !/^\d+$/.test(String(value.payload.amountPaise ?? ''))
      || !['review', 'uncertain', 'conflict'].includes(value.state)) return null;
    return value;
  } catch {
    return null;
  }
}

export function savePendingTransaction(userId, type, attempt, storage = globalThis.localStorage) {
  storage.setItem(transactionStorageKey(userId, type), JSON.stringify(attempt));
}

export function clearPendingTransaction(userId, type, storage = globalThis.localStorage) {
  try {
    storage.removeItem(transactionStorageKey(userId, type));
    return true;
  } catch {
    // A stale key is safe to retry: the server replays its original result.
    return false;
  }
}

export function createSubmissionGuard() {
  let pending = false;
  return {
    tryBegin() {
      if (pending) return false;
      pending = true;
      return true;
    },
    finish() {
      pending = false;
    },
  };
}
