import { createHash } from 'node:crypto';

export function canonicalRequestHash({ type, sourceAccountId, destinationAccountId, amountPaise }) {
  // Explicit ordered fields provide a stable representation independent of JSON
  // object key order or number formatting in the incoming request.
  const canonical = JSON.stringify([
    type,
    sourceAccountId ?? null,
    destinationAccountId ?? null,
    amountPaise.toString(),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export async function postFinancialTransaction(prismaClient, {
  actorId,
  type,
  sourceAccountId,
  destinationAccountId,
  amountPaise,
  idempotencyKey,
}) {
  const requestHash = canonicalRequestHash({
    type,
    sourceAccountId,
    destinationAccountId,
    amountPaise,
  });
  const [result] = await prismaClient.$queryRaw`
    SELECT *
      FROM public.balancevault_post_transaction(
        ${actorId}::uuid,
        ${type}::public."JournalTransactionType",
        ${sourceAccountId ?? null}::uuid,
        ${destinationAccountId ?? null}::uuid,
        ${amountPaise.toString()}::bigint,
        ${idempotencyKey}::text,
        ${requestHash}::char(64)
      )
  `;
  return result;
}

export function safeTransferRecord(journal) {
  return {
    id: journal.id,
    type: journal.type,
    status: journal.status,
    createdAt: journal.createdAt,
    entries: journal.entries.map((entry) => ({
      account: entry.account,
      amountPaise: entry.amountPaise.toString(),
    })),
  };
}
