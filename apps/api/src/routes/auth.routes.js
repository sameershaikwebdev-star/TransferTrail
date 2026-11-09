import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createRateLimitSendCommand, requireRedisReady } from '../config/redis.js';
import { createActorAssertion } from '../config/actor-assertion.js';
import { createAuthenticate } from '../middleware/authenticate.js';
import {
  authenticateCredentials,
  INVALID_CREDENTIALS,
  isUniqueEmailViolation,
  issueAccessToken,
  registerAccountHolder,
  safeUser,
} from '../services/auth.service.js';

const registerSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  password: z.string().min(12).refine(
    (password) => Buffer.byteLength(password, 'utf8') <= 72,
    'Password must be no more than 72 UTF-8 bytes',
  ),
});

const loginSchema = z.strictObject({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(1024),
});
const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).refine(
    (password) => Buffer.byteLength(password, 'utf8') <= 72,
    'Password must be no more than 72 UTF-8 bytes',
  ),
});
const invitationAcceptanceSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(12).refine(
    (password) => Buffer.byteLength(password, 'utf8') <= 72,
    'Password must be no more than 72 UTF-8 bytes',
  ),
});

function createLimiter(limit, message, redisClient, prefix) {
  let limiter;
  return (request, response, next) => {
    limiter ??= rateLimit({
      windowMs: 15 * 60 * 1000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      passOnStoreError: false,
      // This limiter is instantiated once, on the first request after Redis is
      // verified ready, to avoid opening Redis during non-auth app boot/tests.
      validate: { creationStack: false },
      store: new RedisStore({
        sendCommand: createRateLimitSendCommand(redisClient),
        prefix,
      }),
      handler: (_request, result) => result.status(429).json({ error: message }),
    });
    limiter(request, response, next);
  };
}

export function createAuthRouter(prismaClient, { authPrismaClient = prismaClient, redisClient, keyPrefix = 'balancevault' }) {
  const router = Router();
  const redisReady = requireRedisReady(redisClient);
  const registrationLimiter = createLimiter(5, 'Too many registration attempts. Try again later.', redisClient, `${keyPrefix}:register:`);
  const loginLimiter = createLimiter(10, 'Too many login attempts. Try again later.', redisClient, `${keyPrefix}:login:`);
  const passwordLimiter = createLimiter(5, 'Too many password changes. Try again later.', redisClient, `${keyPrefix}:password:`);
  const invitationLimiter = createLimiter(5, 'Too many invitation attempts. Try again later.', redisClient, `${keyPrefix}:invitation:`);

  router.post('/register', redisReady, registrationLimiter, async (request, response, next) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Name, valid email, and a valid password are required' });
      return;
    }

    try {
      const user = await registerAccountHolder(prismaClient, {
        fullName: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
      });
      const accessToken = issueAccessToken(user);
      response.status(201).json({
        accessToken,
        tokenType: 'Bearer',
        expiresIn: 900,
        user: safeUser(user),
      });
    } catch (error) {
      if (isUniqueEmailViolation(error)) {
        response.status(409).json({ error: 'Email is already registered' });
        return;
      }
      next(error);
    }
  });

  router.post('/login', redisReady, loginLimiter, async (request, response, next) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Email and password are required' });
      return;
    }

    try {
      const user = await authenticateCredentials(
        authPrismaClient,
        parsed.data.email,
        parsed.data.password,
      );
      if (!user) {
        response.status(401).json({ error: INVALID_CREDENTIALS });
        return;
      }
      response.status(200).json({
        accessToken: issueAccessToken(user),
        tokenType: 'Bearer',
        expiresIn: 900,
        user: safeUser(user),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/accept-invitation', redisReady, invitationLimiter, async (request, response, next) => {
    const parsed = invitationAcceptanceSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'A valid invitation token and password of at least 12 characters are required' });
    try {
      const tokenHash = createHash('sha256').update(parsed.data.token, 'utf8').digest('hex');
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const [user] = await prismaClient.$queryRaw`
        SELECT * FROM public.accept_privileged_user_invitation(
          ${randomUUID()}::uuid, ${tokenHash}::char(64), ${passwordHash}::text
        )
      `;
      response.set('Cache-Control', 'no-store');
      return response.status(201).json({
        accessToken: issueAccessToken(user),
        tokenType: 'Bearer',
        expiresIn: 900,
        user: safeUser(user),
      });
    } catch (error) {
      const code = error?.meta?.driverAdapterError?.cause?.originalCode ?? error?.meta?.code ?? error?.cause?.code;
      if (code === 'P0002') return response.status(400).json({ error: 'Invitation is invalid, expired, revoked, or already used' });
      if (code === '23505') return response.status(409).json({ error: 'Email is already registered' });
      if (code === '22023') return response.status(400).json({ error: 'Invitation acceptance details are invalid' });
      return next(error);
    }
  });

  router.post('/change-password', createAuthenticate(prismaClient), redisReady, passwordLimiter, async (request, response, next) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Current password and a new password of at least 12 characters are required' });
    try {
      const user = await authPrismaClient.user.findUnique({ where: { id: request.auth.userId }, select: { id: true, passwordHash: true, isActive: true, tokenVersion: true } });
      if (!user?.isActive || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
        return response.status(401).json({ error: 'Current password is incorrect' });
      }
      const newHash = await bcrypt.hash(parsed.data.newPassword, 12);
      const assertion = createActorAssertion(request.auth.userId, 'CHANGE_PASSWORD', [user.id, user.tokenVersion, newHash]);
      await prismaClient.$queryRaw`
        SELECT public.change_user_password_asserted(
          ${user.id}::uuid, ${user.tokenVersion}::integer, ${newHash}::text,
          ${assertion.issuedAt}::bigint, ${assertion.nonce}::uuid,
          ${assertion.contextHash}::text, ${assertion.signature}::text
        )
      `;
      return response.json({ message: 'Password updated. Sign in again with your new password.' });
    } catch (error) { return next(error); }
  });

  return router;
}
