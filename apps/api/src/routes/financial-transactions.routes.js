import { Router } from 'express';
import { z } from 'zod';
import { createAuthenticate } from '../middleware/authenticate.js';
import { postFinancialTransaction, safeTransferRecord } from '../services/financial-transaction.service.js';

const accountId = z.string().uuid();
const amountPaise = z.union([
  z.number().int().positive().safe().transform((value) => BigInt(value)),
  z.string().regex(/^[1-9]\d*$/).transform((value) => BigInt(value)),
]).refine((value) => value <= BigInt(Number.MAX_SAFE_INTEGER), 'Amount exceeds supported API range');
const depositSchema = z.strictObject({
  accountId,
  amountPaise,
});
const withdrawalSchema = z.strictObject({
  accountId,
  amountPaise,
});
const transferSchema = z.strictObject({
  sourceAccountId: accountId,
  destinationAccountId: accountId,
  amountPaise,
}).refine((value) => value.sourceAccountId !== value.destinationAccountId, {
  message: 'Source and destination accounts must differ',
});
const transferIdSchema = z.string().uuid();

function parseIdempotencyKey(request, response) {
  const parsed = z.string().trim().min(1).max(255).safeParse(request.get('idempotency-key'));
  if (!parsed.success) {
    response.status(400).json({ error: 'A valid Idempotency-Key header is required' });
    return null;
  }
  return parsed.data;
}

function parseBody(schema, request, response, message) {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: message });
    return null;
  }
  return parsed.data;
}

async function post(request, response, next, prismaClient, type, parsed, sourceAccountId, destinationAccountId) {
  const idempotencyKey = parseIdempotencyKey(request, response);
  if (!idempotencyKey) return;

  try {
    const result = await postFinancialTransaction(prismaClient, {
      actorId: request.auth.userId,
      type,
      sourceAccountId,
      destinationAccountId,
      amountPaise: parsed.amountPaise,
      idempotencyKey,
    });
    response.status(result.response_status).json(result.response_body);
  } catch (error) {
    // PostgreSQL BIGINT overflow is a client amount-range error; other database
    // failures remain centralized and are not exposed to clients.
    const sqlState = error?.meta?.driverAdapterError?.cause?.originalCode
      ?? error?.meta?.code
      ?? error?.cause?.code;
    if (sqlState === '22003') {
      response.status(400).json({ error: 'Amount exceeds supported range' });
      return;
    }
    next(error);
  }
}

export function createFinancialTransactionsRouter(prismaClient) {
  const router = Router();
  const authenticate = createAuthenticate(prismaClient);

  router.post('/deposits', authenticate, async (request, response, next) => {
    const parsed = parseBody(depositSchema, request, response, 'A valid customer account ID and positive integer amountPaise are required');
    if (!parsed) return;
    await post(request, response, next, prismaClient, 'DEPOSIT', parsed, null, parsed.accountId);
  });

  router.post('/withdrawals', authenticate, async (request, response, next) => {
    const parsed = parseBody(withdrawalSchema, request, response, 'A valid customer account ID and positive integer amountPaise are required');
    if (!parsed) return;
    await post(request, response, next, prismaClient, 'WITHDRAWAL', parsed, parsed.accountId, null);
  });

  router.post('/transfers', authenticate, async (request, response, next) => {
    const parsed = parseBody(transferSchema, request, response, 'Valid distinct source and destination account IDs and positive integer amountPaise are required');
    if (!parsed) return;
    await post(
      request,
      response,
      next,
      prismaClient,
      'TRANSFER',
      parsed,
      parsed.sourceAccountId,
      parsed.destinationAccountId,
    );
  });

  router.get('/transfers/:id', authenticate, async (request, response, next) => {
    const parsedId = transferIdSchema.safeParse(request.params.id);
    if (!parsedId.success) {
      response.status(400).json({ error: 'Invalid transfer ID' });
      return;
    }

    const visibleCustomerAccount = {
      type: { in: ['PERSONAL', 'BUSINESS'] },
      systemCode: null,
      ...(request.auth.role === 'ADMIN'
        ? {}
        : { permissions: { some: { userId: request.auth.userId, canView: true } } }),
    };

    try {
      const journal = await prismaClient.journalTransaction.findFirst({
        where: {
          id: parsedId.data,
          type: 'TRANSFER',
          status: 'POSTED',
          entries: { every: { account: visibleCustomerAccount } },
        },
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
          entries: {
            orderBy: { postingSequence: 'asc' },
            select: {
              amountPaise: true,
              account: { select: { id: true, accountNumber: true, type: true, currencyCode: true } },
            },
          },
        },
      });
      if (!journal || journal.entries.length !== 2) {
        response.status(404).json({ error: 'Transfer not found' });
        return;
      }
      response.json({ transfer: safeTransferRecord(journal) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
