import { Router } from 'express';
import { z } from 'zod';
import { createAuthenticate } from '../middleware/authenticate.js';

const requestSchema = z.strictObject({ requestedType: z.enum(['PERSONAL', 'BUSINESS']).default('PERSONAL') });
const approveSchema = z.strictObject({ accountNumber: z.string().trim().min(1).max(64) });
const rejectSchema = z.strictObject({ note: z.string().trim().max(500).optional() });
const idSchema = z.string().uuid();
function sqlState(error) { return error?.meta?.driverAdapterError?.cause?.originalCode ?? error?.meta?.code ?? error?.cause?.code; }

export function createAccountOpeningRouter(prismaClient) {
  const router = Router();
  router.use(createAuthenticate(prismaClient));

  router.post('/', async (request, response, next) => {
    if (request.auth.role !== 'ACCOUNT_HOLDER') return response.status(403).json({ error: 'Forbidden' });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'A valid customer account type is required' });
    try {
      const [accountRequest] = await prismaClient.$queryRaw`
        SELECT * FROM public.request_account_opening(${request.auth.userId}::uuid, ${parsed.data.requestedType}::public."AccountType")
      `;
      return response.status(201).json({ request: accountRequest });
    } catch (error) {
      if (sqlState(error) === '23505') {
        return response.status(409).json({ error: 'A pending account request already exists' });
      }
      return next(error);
    }
  });

  router.get('/', async (request, response, next) => {
    try {
      const requests = await prismaClient.accountOpeningRequest.findMany({
        where: request.auth.role === 'ADMIN' ? undefined : { userId: request.auth.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: {
          id: true, requestedType: true, status: true, reviewNote: true, createdAt: true, resolvedAt: true,
          account: { select: { id: true, accountNumber: true, type: true, status: true } },
        },
      });
      return response.json({ requests });
    } catch (error) { return next(error); }
  });

  router.get('/admin/queue', async (request, response, next) => {
    if (request.auth.role !== 'ADMIN') return response.status(403).json({ error: 'Forbidden' });
    try {
      const requests = await prismaClient.accountOpeningRequest.findMany({
        where: { status: 'PENDING' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100,
        select: { id: true, requestedType: true, status: true, createdAt: true, user: { select: { id: true, fullName: true, email: true } } },
      });
      return response.json({ requests });
    } catch (error) { return next(error); }
  });

  router.post('/admin/:id/approve', async (request, response, next) => {
    if (request.auth.role !== 'ADMIN') return response.status(403).json({ error: 'Forbidden' });
    const id = idSchema.safeParse(request.params.id);
    const body = approveSchema.safeParse(request.body);
    if (!id.success || !body.success) return response.status(400).json({ error: 'Valid request ID and account number are required' });
    try {
      const [account] = await prismaClient.$queryRaw`
        SELECT * FROM public.approve_account_opening(${request.auth.userId}::uuid, ${id.data}::uuid, ${body.data.accountNumber}::text)
      `;
      return response.json({ account });
    } catch (error) {
      if (sqlState(error) === 'P0002') return response.status(404).json({ error: 'Pending account request not found' });
      if (sqlState(error) === '42501') return response.status(403).json({ error: 'Forbidden' });
      if (sqlState(error) === '23505') return response.status(409).json({ error: 'Account number is already in use' });
      return next(error);
    }
  });

  router.post('/admin/:id/reject', async (request, response, next) => {
    if (request.auth.role !== 'ADMIN') return response.status(403).json({ error: 'Forbidden' });
    const id = idSchema.safeParse(request.params.id);
    const body = rejectSchema.safeParse(request.body);
    if (!id.success || !body.success) return response.status(400).json({ error: 'Valid request ID is required' });
    try {
      await prismaClient.$queryRaw`SELECT public.reject_account_opening(${request.auth.userId}::uuid, ${id.data}::uuid, ${body.data.note ?? null}::text)`;
      return response.json({ status: 'REJECTED' });
    } catch (error) {
      if (sqlState(error) === 'P0002') return response.status(404).json({ error: 'Pending account request not found' });
      if (sqlState(error) === '42501') return response.status(403).json({ error: 'Forbidden' });
      return next(error);
    }
  });

  return router;
}
