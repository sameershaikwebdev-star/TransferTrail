import { z } from 'zod';

const cursorSchema = z.strictObject({
  position: z.string().regex(/^(0|[1-9]\d*)$/),
  kindOrder: z.union([z.literal(0), z.literal(1)]),
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});

export function decodeStatementCursor(value) {
  if (value === undefined) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : false;
  } catch {
    return false;
  }
}

function encodeStatementCursor(row) {
  return Buffer.from(JSON.stringify({
    position: row.sortPosition.toString(),
    kindOrder: row.kindOrder,
    createdAt: row.createdAt.toISOString(),
    id: row.eventId,
  })).toString('base64url');
}

function accountReadFilter(auth) {
  if (auth.role === 'ADMIN') return {};
  if (auth.role !== 'ACCOUNT_HOLDER' && auth.role !== 'AUDITOR') return null;
  return { permissions: { some: { userId: auth.userId, canView: true } } };
}

export async function getAccountStatement(prismaClient, { accountId, auth, limit, cursor }) {
  const visibility = accountReadFilter(auth);
  if (!visibility) return { notFound: true };

  return prismaClient.$transaction(async (tx) => {
    const account = await tx.account.findFirst({
      where: {
        AND: [
          { id: accountId, type: { in: ['PERSONAL', 'BUSINESS'] }, systemCode: null },
          visibility,
        ],
      },
      select: { id: true, accountNumber: true, type: true, currencyCode: true },
    });
    if (!account) return { notFound: true };

    const cursorPosition = cursor?.position ?? null;
    const cursorKindOrder = cursor?.kindOrder ?? null;
    const cursorCreatedAt = cursor?.createdAt ?? null;
    const cursorId = cursor?.id ?? null;
    const rows = await tx.$queryRaw`
      WITH posted AS (
        SELECT e."id" AS "eventId",
               e."createdAt",
               e."accountPostingSequence" AS "sortPosition",
               0::integer AS "kindOrder",
               'POSTED'::text AS "eventKind",
               j."type"::text AS "transactionType",
               e."amountPaise" AS "amountPaise",
               'POSTED'::text AS "status",
               j."reference" AS "reference",
               j."actorId" AS "actorId",
               u."role"::text AS "actorRole",
               sum(e."amountPaise") OVER (
                 ORDER BY e."accountPostingSequence"
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               )::bigint AS "runningBalancePaise"
          FROM public."LedgerEntry" e
          JOIN public."JournalTransaction" j ON j."id" = e."journalTransactionId"
          JOIN public."User" u ON u."id" = j."actorId"
         WHERE e."accountId" = ${accountId}::uuid
           AND j."status" = 'POSTED'::public."JournalTransactionStatus"
      ), refused_positions AS (
        SELECT a."id" AS "eventId",
               a."createdAt",
               COALESCE((
                 SELECT max(e."accountPostingSequence")
                   FROM public."LedgerEntry" e
                   JOIN public."JournalTransaction" j ON j."id" = e."journalTransactionId"
                  WHERE e."accountId" = ${accountId}::uuid
                    AND j."status" = 'POSTED'::public."JournalTransactionStatus"
                    AND e."createdAt" <= a."createdAt"
               ), 0)::bigint AS "sortPosition",
               a."type"::text AS "transactionType",
               a."requestedAmountPaise" AS "amountPaise",
               a."refusalReason",
               a."actorId",
               u."role"::text AS "actorRole"
          FROM public."TransactionAttempt" a
          JOIN public."User" u ON u."id" = a."actorId"
         WHERE a."status" = 'REFUSED'::public."TransactionAttemptStatus"
           AND (a."sourceAccountId" = ${accountId}::uuid OR a."destinationAccountId" = ${accountId}::uuid)
      ), refused AS (
        SELECT r."eventId",
               r."createdAt",
               r."sortPosition",
               1::integer AS "kindOrder",
               'REFUSED'::text AS "eventKind",
               r."transactionType",
               r."amountPaise",
               'REFUSED'::text AS "status",
               r."eventId"::text AS "reference",
               r."actorId",
               r."actorRole",
               COALESCE((
                 SELECT sum(e."amountPaise")
                   FROM public."LedgerEntry" e
                   JOIN public."JournalTransaction" j ON j."id" = e."journalTransactionId"
                  WHERE e."accountId" = ${accountId}::uuid
                    AND j."status" = 'POSTED'::public."JournalTransactionStatus"
                    AND e."accountPostingSequence" <= r."sortPosition"
               ), 0)::bigint AS "runningBalancePaise",
               r."refusalReason"
          FROM refused_positions r
      ), statement_events AS (
        SELECT p."eventId",p."createdAt",p."sortPosition",p."kindOrder",p."eventKind",
               p."transactionType",p."amountPaise",p."status",p."reference",p."actorId",
               p."actorRole",p."runningBalancePaise",NULL::text AS "refusalReason"
          FROM posted p
        UNION ALL
        SELECT r."eventId",r."createdAt",r."sortPosition",r."kindOrder",r."eventKind",
               r."transactionType",r."amountPaise",r."status",r."reference",r."actorId",
               r."actorRole",r."runningBalancePaise",r."refusalReason"
          FROM refused r
      ), cursor_event AS (
        -- Resolve the timestamp in PostgreSQL to preserve sub-millisecond precision
        -- for cursors encoded from JavaScript Dates.
        SELECT c."createdAt"
          FROM statement_events c
         WHERE c."sortPosition" = ${cursorPosition}::bigint
           AND c."kindOrder" = ${cursorKindOrder}::integer
           AND c."eventId" = ${cursorId}::uuid
      )
      SELECT * FROM statement_events e
       WHERE ${cursorPosition}::bigint IS NULL
          OR (e."sortPosition",e."kindOrder",e."createdAt",e."eventId") >
             (${cursorPosition}::bigint,${cursorKindOrder}::integer,
              COALESCE((SELECT "createdAt" FROM cursor_event), ${cursorCreatedAt}::timestamptz),
              ${cursorId}::uuid)
       ORDER BY e."sortPosition",e."kindOrder",e."createdAt",e."eventId"
       LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const events = pageRows.map((row) => ({
      id: row.eventId,
      type: row.transactionType,
      amountPaise: row.amountPaise.toString(),
      status: row.status,
      timestamp: row.createdAt,
      reference: row.reference,
      actor: { id: row.actorId, role: row.actorRole },
      runningBalancePaise: row.runningBalancePaise.toString(),
      ...(row.refusalReason ? { refusalReason: row.refusalReason } : {}),
    }));

    return {
      account,
      events,
      nextCursor: hasMore ? encodeStatementCursor(pageRows.at(-1)) : null,
    };
  }, { isolationLevel: 'RepeatableRead' });
}
