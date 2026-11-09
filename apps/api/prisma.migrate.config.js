import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, env } from 'prisma/config';

const apiDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.resolve(apiDirectory, '../../.env');

dotenv.config({ path: rootEnvPath });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('MIGRATION_DATABASE_URL'),
  },
});
