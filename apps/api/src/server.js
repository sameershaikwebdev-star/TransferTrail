import 'dotenv/config';
import { createApp } from './app.js';
import { validateAuthConfig } from './config/auth.js';
import { validateRuntimeConfig, verifyAuthDatabaseIdentity, verifyRuntimeDatabaseIdentity } from './config/runtime.js';
import { connectRedisClient, redisClient } from './config/redis.js';
import { prisma } from './db/prisma.js';
import { createAuthPrisma } from './db/auth-prisma.js';

const runtimeConfig = validateRuntimeConfig();
validateAuthConfig();
const authPrisma = createAuthPrisma({
  connectionString: runtimeConfig.authDatabaseUrl,
  max: runtimeConfig.pool.max,
  connectionTimeoutMillis: runtimeConfig.pool.connectionTimeoutMillis,
});
const app = createApp({ prismaClient: prisma, authPrismaClient: authPrisma });

await verifyRuntimeDatabaseIdentity(prisma);
await verifyAuthDatabaseIdentity(authPrisma);
await connectRedisClient(redisClient);
const server = app.listen(runtimeConfig.port, '0.0.0.0', () => {
  console.log(`BalanceVault API listening on port ${runtimeConfig.port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  server.close(async () => {
    if (redisClient.isOpen) await redisClient.quit();
    await prisma.$disconnect();
    await authPrisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
