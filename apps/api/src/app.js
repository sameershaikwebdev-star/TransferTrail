import cors from 'cors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { prisma } from './db/prisma.js';
import { createAccountsRouter } from './routes/accounts.routes.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createAuditRouter } from './routes/audit.routes.js';
import { createFinancialTransactionsRouter } from './routes/financial-transactions.routes.js';
import { createUsersRouter } from './routes/users.routes.js';
import { createAccountOpeningRouter } from './routes/account-opening.routes.js';
import { createAdminRouter } from './routes/admin.routes.js';
import { validateRuntimeConfig } from './config/runtime.js';
import { connectRedisClient, redisClient } from './config/redis.js';

const runtimeConfig = validateRuntimeConfig();

export function createApp({
  prismaClient = prisma,
  authPrismaClient = prismaClient,
  rateLimitRedisClient = redisClient,
  rateLimitNamespace = 'balancevault',
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  if (runtimeConfig.production) app.set('trust proxy', 1);
  app.use((request, response, next) => {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'X-Request-Id': randomUUID(),
    };
    if (runtimeConfig.production && request.secure) {
      headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    }
    request.id = headers['X-Request-Id'];
    response.set(headers);
    next();
  });
  app.use(cors({
    origin: runtimeConfig.origins,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    maxAge: 600,
  }));
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_request, response) => {
    response.json({ application: 'BalanceVault', status: 'healthy' });
  });

  app.get('/api/ready', async (_request, response) => {
    let timeout;
    try {
      await Promise.race([
        Promise.all([
          prismaClient.$queryRaw`SELECT 1`,
          authPrismaClient.$queryRaw`SELECT 1`,
          connectRedisClient(rateLimitRedisClient).then(() => rateLimitRedisClient.ping()),
        ]),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Readiness checks timed out')), runtimeConfig.databaseReadyTimeoutMillis);
          timeout.unref?.();
        }),
      ]);
      response.status(200).json({ application: 'BalanceVault', status: 'ready' });
    } catch {
      response.status(503).json({ application: 'BalanceVault', status: 'not_ready' });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.use('/api/auth', createAuthRouter(prismaClient, {
    authPrismaClient,
    redisClient: rateLimitRedisClient,
    keyPrefix: rateLimitNamespace,
  }));
  app.use('/api/users', createUsersRouter(prismaClient));
  app.use('/api/account-requests', createAccountOpeningRouter(prismaClient));
  app.use('/api/admin', createAdminRouter(prismaClient, { authPrismaClient }));
  app.use('/api/audit', createAuditRouter(prismaClient));
  app.use('/api/accounts', createAccountsRouter(prismaClient));
  app.use('/api', createFinancialTransactionsRouter(prismaClient));

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'API route not found' });
  });

  app.use((error, _request, response, _next) => {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;

    if (status >= 500) {
  console.error('Unhandled request error', {
    requestId: _request.id,
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    meta: error?.meta ?? null,
    clientVersion: error?.clientVersion ?? null,
  });
}

    response.status(status).json({
      error: status >= 500 ? 'Internal server error' : error.message,
    });
  });

  return app;
}

const app = createApp();

export default app;
