import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/index.js';

export function createAuthPrisma({ connectionString, max = 10, connectionTimeoutMillis = 5000 }) {
  if (!connectionString) throw new Error('AUTH_DATABASE_URL must be configured');
  const adapter = new PrismaPg({
    connectionString,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis: 30_000,
  });

  // This pool alone receives the narrowly scoped read privilege on passwordHash.
  return new PrismaClient({ adapter });
}
