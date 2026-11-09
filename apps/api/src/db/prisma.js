import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/index.js';
import { validateRuntimeConfig } from '../config/runtime.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
dotenv.config({ path: path.join(repositoryRoot, '.env') });

const runtimeConfig = validateRuntimeConfig();
const adapter = new PrismaPg({
  connectionString: runtimeConfig.databaseUrl,
  max: runtimeConfig.pool.max,
  connectionTimeoutMillis: runtimeConfig.pool.connectionTimeoutMillis,
  idleTimeoutMillis: 30_000,
});

export const prisma = new PrismaClient({ adapter });
