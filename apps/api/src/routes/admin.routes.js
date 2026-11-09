import { Router } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { createAuthenticate } from '../middleware/authenticate.js';
import { createActorAssertion } from '../config/actor-assertion.js';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
  role: z.enum(['ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
}).strict();
const capabilitiesSchema = z.strictObject({
  canDeposit: z.boolean(),
  canWithdraw: z.boolean(),
  canTransfer: z.boolean(),
});
const permissionsSchema = capabilitiesSchema.extend({
  expected: capabilitiesSchema,
  adminPassword: z.string().min(1).max(1024),
});

// Simple per-administrator throttle for password confirmations (in memory; per API process).
const passwordFailures = new Map();
const MAX_PASSWORD_FAILURES = 5;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;
function passwordLocked(userId) {
  const entry = passwordFailures.get(userId);
  if (!entry) return false;
  if (Date.now() - entry.first > PASSWORD_WINDOW_MS) { passwordFailures.delete(userId); return false; }
  return entry.count >= MAX_PASSWORD_FAILURES;
}
function recordPasswordFailure(userId) {
  const entry = passwordFailures.get(userId);
  if (!entry || Date.now() - entry.first > PASSWORD_WINDOW_MS) passwordFailures.set(userId, { first: Date.now(), count: 1 });
  else entry.count += 1;
}
const statusSchema = z.strictObject({ isActive: z.boolean() });
const idSchema = z.string().uuid();
const invitationSchema = z.strictObject({
  fullName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  role: z.enum(['ADMIN', 'AUDITOR']),
});
function sqlState(error) { return error?.meta?.driverAdapterError?.cause?.originalCode ?? error?.meta?.code ?? error?.cause?.code; }

export function createAdminRouter(prismaClient, { authPrismaClient = prismaClient } = {}) {
  const router = Router();
  router.use(createAuthenticate(prismaClient));
  router.use((request, response, next) => request.auth.role === 'ADMIN' ? next() : response.status(403).json({ error: 'Forbidden' }));

  router.get('/accounts/:accountId/permissions', async (request, response, next) => {
    const accountId = idSchema.safeParse(request.params.accountId);
    if (!accountId.success) return response.status(400).json({ error: 'Valid account ID is required' });
    try {
      const account = await prismaClient.account.findFirst({
        where: { id: accountId.data, type: { in: ['PERSONAL', 'BUSINESS'] }, systemCode: null },
        select: { id: true, status: true },
      });
      if (!account) return response.status(404).json({ error: 'Customer account not found' });
      const permissions = await prismaClient.accountPermission.findMany({
        where: { accountId: account.id, canView: true, user: { role: 'ACCOUNT_HOLDER' } },
        orderBy: { userId: 'asc' },
        select: {
          userId: true, canDeposit: true, canWithdraw: true, canTransfer: true,
          user: { select: { fullName: true, email: true, isActive: true } },
        },
      });
      response.set('Cache-Control', 'no-store');
      return response.json({ account, permissions });
    } catch (error) { return next(error); }
  });

  router.patch('/accounts/:accountId/permissions/:userId', async (request, response, next) => {
    const accountId = idSchema.safeParse(request.params.accountId);
    const holderId = idSchema.safeParse(request.params.userId);
    const body = permissionsSchema.safeParse(request.body);
    if (!accountId.success || !holderId.success || !body.success) {
      return response.status(400).json({ error: 'Valid account, holder, boolean permissions, and your administrator password are required' });
    }
    const { canDeposit, canWithdraw, canTransfer, expected, adminPassword } = body.data;
    try {
      // Step-up authentication: the signed-in administrator must re-enter their password.
      if (passwordLocked(request.auth.userId)) {
        return response.status(429).json({ error: 'Too many incorrect password attempts. Try again in 15 minutes.' });
      }
      const admin = await authPrismaClient.user.findUnique({
        where: { id: request.auth.userId },
        select: { passwordHash: true, isActive: true, role: true },
      });
      if (!admin?.isActive || admin.role !== 'ADMIN' || !(await bcrypt.compare(adminPassword, admin.passwordHash))) {
        recordPasswordFailure(request.auth.userId);
        return response.status(403).json({ error: 'Administrator password is incorrect' });
      }
      passwordFailures.delete(request.auth.userId);
      const assertion = createActorAssertion(request.auth.userId, 'ACCOUNT_PERMISSIONS_UPDATE', [
        accountId.data.toLowerCase(), holderId.data.toLowerCase(),
        canDeposit, canWithdraw, canTransfer,
        expected.canDeposit, expected.canWithdraw, expected.canTransfer,
      ]);
      const [result] = await prismaClient.$queryRaw`
        SELECT public.set_account_permissions_asserted(
          ${request.auth.userId}::uuid, ${accountId.data}::uuid, ${holderId.data}::uuid,
          ${canDeposit}::boolean, ${canWithdraw}::boolean, ${canTransfer}::boolean,
          ${expected.canDeposit}::boolean, ${expected.canWithdraw}::boolean, ${expected.canTransfer}::boolean,
          ${assertion.issuedAt}::bigint, ${assertion.nonce}::uuid,
          ${assertion.contextHash}::text, ${assertion.signature}::text
        ) AS changed
      `;
      response.set('Cache-Control', 'no-store');
      return response.json({ changed: result.changed, canDeposit, canWithdraw, canTransfer });
    } catch (error) {
      if (sqlState(error) === '42501') return response.status(403).json({ error: 'Administrator authorization is required' });
      if (sqlState(error) === 'P0002') return response.status(404).json({ error: 'Assigned account holder not found' });
      if (sqlState(error) === '22023') return response.status(422).json({ error: 'An active customer account and active account holder are required' });
      if (sqlState(error) === '40001') return response.status(409).json({ error: 'Permissions changed. Reload permissions and review them before saving again.' });
      return next(error);
    }
  });

  router.post('/invitations', async (request, response, next) => {
    const parsed = invitationSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Full name, valid email, and ADMIN or AUDITOR role are required' });
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const context = [id, parsed.data.fullName, parsed.data.email, parsed.data.role, tokenHash, expiresAt.getTime()];
    const assertion = createActorAssertion(request.auth.userId, 'INVITATION_CREATE', context);
    try {
      const [invitation] = await prismaClient.$queryRaw`
        SELECT * FROM public.create_privileged_user_invitation_asserted(
          ${request.auth.userId}::uuid, ${id}::uuid, ${parsed.data.fullName}::text,
          ${parsed.data.email}::text, ${parsed.data.role}::public."UserRole",
          ${tokenHash}::char(64), ${expiresAt}::timestamptz, ${expiresAt.getTime()}::bigint,
          ${assertion.issuedAt}::bigint, ${assertion.nonce}::uuid, ${assertion.contextHash}::text, ${assertion.signature}::text
        )
      `;
      response.set('Cache-Control', 'no-store');
      return response.status(201).json({ invitation: { ...invitation, token } });
    } catch (error) {
      if (sqlState(error) === '42501') return response.status(403).json({ error: 'Administrator authorization is required' });
      if (sqlState(error) === '23505') return response.status(409).json({ error: 'Email is already registered or has an active invitation' });
      if (sqlState(error) === '22023') return response.status(400).json({ error: 'Invitation details are invalid' });
      return next(error);
    }
  });

  router.get('/invitations', async (_request, response, next) => {
    try {
      const invitations = await prismaClient.userInvitation.findMany({
        take: 100,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, fullName: true, email: true, role: true, expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true, createdByUserId: true, acceptedByUserId: true },
      });
      return response.json({ invitations });
    } catch (error) { return next(error); }
  });

  router.post('/invitations/:id/revoke', async (request, response, next) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: 'Valid invitation ID is required' });
    try {
      const assertion = createActorAssertion(request.auth.userId, 'INVITATION_REVOKE', [id.data]);
      const [row] = await prismaClient.$queryRaw`
        SELECT public.revoke_privileged_user_invitation_asserted(
          ${request.auth.userId}::uuid, ${id.data}::uuid,
          ${assertion.issuedAt}::bigint, ${assertion.nonce}::uuid,
          ${assertion.contextHash}::text, ${assertion.signature}::text
        ) AS changed
      `;
      if (!row.changed) return response.status(409).json({ error: 'Invitation is already accepted, revoked, or unavailable' });
      return response.json({ id: id.data, revoked: true });
    } catch (error) {
      if (sqlState(error) === '42501') return response.status(403).json({ error: 'Administrator authorization is required' });
      return next(error);
    }
  });

  router.get('/users', async (request, response, next) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return response.status(400).json({ error: 'Invalid pagination parameters' });
    try {
      const { page, perPage, search, role, status } = parsed.data;
      const where = {
        ...(role ? { role } : {}),
        ...(status ? { isActive: status === 'ACTIVE' } : {}),
        ...(search ? { OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ] } : {}),
      };
      const users = await prismaClient.user.findMany({
        skip: (page - 1) * perPage, take: perPage + 1,
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, fullName: true, email: true, role: true, isActive: true, createdAt: true },
      });
      return response.json({ users: users.slice(0, perPage), page, perPage, hasMore: users.length > perPage });
    } catch (error) { return next(error); }
  });

  router.patch('/users/:id/status', async (request, response, next) => {
    const id = idSchema.safeParse(request.params.id);
    const body = statusSchema.safeParse(request.body);
    if (!id.success || !body.success) return response.status(400).json({ error: 'Valid user ID and active status are required' });
    try {
      const [changed] = await prismaClient.$queryRaw`
        SELECT public.admin_set_user_active(${request.auth.userId}::uuid, ${id.data}::uuid, ${body.data.isActive}::boolean) AS changed
      `;
      return response.json({ id: id.data, isActive: body.data.isActive, changed: changed.changed });
    } catch (error) {
      if (sqlState(error) === '42501') return response.status(403).json({ error: 'This status change is not permitted' });
      if (sqlState(error) === '23514') return response.status(409).json({ error: 'The user is the only active account holder for an account' });
      return next(error);
    }
  });
  return router;
}
