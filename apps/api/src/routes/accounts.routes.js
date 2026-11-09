import { Router } from 'express';
import { z } from 'zod';
import { createAuthenticate } from '../middleware/authenticate.js';
import { decodeStatementCursor, getAccountStatement } from '../services/statement.service.js';
import {
  createCustomerAccount,
  getAccountFunctionSqlState,
  isDuplicateAccountNumber,
  safeAccount,
} from '../services/account.service.js';

// PostgreSQL accepts every canonical UUID bit pattern, including the nil/version-0
// UUID used by the disposable clearing-account fixtures. Validate its syntax here;
// authorization and existence are still resolved by the database query.
const accountIdSchema = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
const createAccountSchema = z.strictObject({
  accountNumber: z.string().trim().min(1).max(64),
  accountType: z.enum(['PERSONAL', 'BUSINESS']),
  holderUserId: z.string().uuid(),
});
const lookupSchema = z.union([
  z.strictObject({ accountNumber: z.string().trim().min(1).max(64) }),
  z.strictObject({ accountId: z.string().uuid() }),
]);

// Limits how many destination lookups one signed-in user can make, so the endpoint
// cannot be used to scan for valid account numbers. In memory, per API process.
const lookupHistory = new Map();
const LOOKUP_LIMIT = 30;
const LOOKUP_WINDOW_MS = 15 * 60 * 1000;
function lookupThrottled(userId) {
  const now = Date.now();
  const recent = (lookupHistory.get(userId) ?? []).filter((time) => now - time < LOOKUP_WINDOW_MS);
  if (recent.length >= LOOKUP_LIMIT) { lookupHistory.set(userId, recent); return true; }
  recent.push(now);
  lookupHistory.set(userId, recent);
  return false;
}

// Shows enough to confirm the recipient without exposing a full name.
function maskedHolderName(fullName) {
  const parts = typeof fullName === 'string' ? fullName.trim().split(/\s+/).filter(Boolean) : [];
  if (parts.length === 0) return 'Account holder';
  return [parts[0], ...parts.slice(1).map((part) => `${part[0].toUpperCase()}.`)].join(' ');
}

const customerAccountFilter = {
  type: { in: ['PERSONAL', 'BUSINESS'] },
  systemCode: null,
};

const accountSummarySelect = {
  id: true,
  accountNumber: true,
  type: true,
  status: true,
  currencyCode: true,
  createdAt: true,
};

function readFilter(auth) {
  if (auth.role === 'ADMIN') return customerAccountFilter;
  if (auth.role !== 'ACCOUNT_HOLDER' && auth.role !== 'AUDITOR') return null;

  return {
    ...customerAccountFilter,
    permissions: {
      some: { userId: auth.userId, canView: true },
    },
  };
}

function validateAccountId(request, response) {
  const parsed = accountIdSchema.safeParse(request.params.id);
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid account ID' });
    return null;
  }
  return parsed.data;
}

export function createAccountsRouter(prismaClient) {
  const router = Router();
  router.use(createAuthenticate(prismaClient));

  // Destination lookup for transfers. Returns the same generic 404 for every
  // account that cannot receive a transfer, and never returns balances.
  router.post('/lookup', async (request, response, next) => {
    if (request.auth.role !== 'ACCOUNT_HOLDER') {
      response.status(403).json({ error: 'Forbidden' });
      return;
    }
    const parsed = lookupSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'A valid account number is required' });
      return;
    }
    if (lookupThrottled(request.auth.userId)) {
      response.status(429).json({ error: 'Too many lookups. Try again in a few minutes.' });
      return;
    }
    try {
      const account = await prismaClient.account.findFirst({
        where: {
          ...customerAccountFilter,
          status: 'ACTIVE',
          currencyCode: 'INR',
          ...('accountNumber' in parsed.data ? { accountNumber: parsed.data.accountNumber } : { id: parsed.data.accountId }),
        },
        select: {
          id: true, accountNumber: true, type: true, status: true, currencyCode: true,
          permissions: {
            where: { canView: true, user: { role: 'ACCOUNT_HOLDER', isActive: true } },
            orderBy: { userId: 'asc' },
            take: 1,
            select: { user: { select: { fullName: true } } },
          },
        },
      });
      if (!account) {
        response.status(404).json({ error: 'Account not found' });
        return;
      }
      response.set('Cache-Control', 'no-store');
      response.json({
        account: {
          id: account.id,
          accountNumber: account.accountNumber,
          type: account.type,
          status: account.status,
          currencyCode: account.currencyCode,
          holderName: maskedHolderName(account.permissions[0]?.user?.fullName),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (request, response, next) => {
    if (request.auth.role !== 'ADMIN') {
      response.status(403).json({ error: 'Forbidden' });
      return;
    }

    const parsed = createAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Valid account number, type, and holder user ID are required' });
      return;
    }

    try {
      const account = await createCustomerAccount(prismaClient, request.auth.userId, parsed.data);
      response.status(201).json({ account: safeAccount(account) });
    } catch (error) {
      if (isDuplicateAccountNumber(error)) {
        response.status(409).json({ error: 'Account number is already in use' });
        return;
      }
      const sqlState = getAccountFunctionSqlState(error);
      if (sqlState === '42501') {
        response.status(403).json({ error: 'Forbidden' });
        return;
      }
      if (sqlState === '22023') {
        response.status(422).json({ error: 'Active account holder and valid customer account details are required' });
        return;
      }
      next(error);
    }
  });

  router.get('/', async (request, response, next) => {
    const where = readFilter(request.auth);
    if (!where) {
      response.status(403).json({ error: 'Forbidden' });
      return;
    }

    try {
      const accounts = await prismaClient.account.findMany({
        where,
        select: accountSummarySelect,
        orderBy: { createdAt: 'desc' },
      });
      response.json({ accounts });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/balance', async (request, response, next) => {
    const accountId = validateAccountId(request, response);
    if (!accountId) return;
    const permissionFilter = readFilter(request.auth);
    if (!permissionFilter) {
      response.status(403).json({ error: 'Forbidden' });
      return;
    }

    try {
      const account = await prismaClient.account.findFirst({
        where: { AND: [{ id: accountId }, permissionFilter] },
        select: {
          id: true,
          balancePaise: true,
          currencyCode: true,
        },
      });
      if (!account) {
        response.status(404).json({ error: 'Account not found' });
        return;
      }
      response.json({
        accountId: account.id,
        balancePaise: account.balancePaise.toString(),
        currencyCode: account.currencyCode,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/statement', async (request, response, next) => {
    const accountId = validateAccountId(request, response);
    if (!accountId) return;
    const limitParsed = z.coerce.number().int().min(1).max(100).default(25).safeParse(request.query.limit);
    if (!limitParsed.success) {
      response.status(400).json({ error: 'Statement limit must be an integer between 1 and 100' });
      return;
    }
    const cursor = decodeStatementCursor(request.query.cursor);
    if (cursor === false) {
      response.status(400).json({ error: 'Invalid statement cursor' });
      return;
    }

    try {
      const statement = await getAccountStatement(prismaClient, {
        accountId,
        auth: request.auth,
        limit: limitParsed.data,
        cursor,
      });
      if (statement.notFound) {
        response.status(404).json({ error: 'Account not found' });
        return;
      }
      response.json(statement);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (request, response, next) => {
    const accountId = validateAccountId(request, response);
    if (!accountId) return;
    const permissionFilter = readFilter(request.auth);
    if (!permissionFilter) {
      response.status(403).json({ error: 'Forbidden' });
      return;
    }

    try {
      const account = await prismaClient.account.findFirst({
        where: { AND: [{ id: accountId }, permissionFilter] },
        select: accountSummarySelect,
      });
      if (!account) {
        response.status(404).json({ error: 'Account not found' });
        return;
      }
      response.json({ account });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
