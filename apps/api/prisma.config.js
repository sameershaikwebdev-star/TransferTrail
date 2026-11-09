import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const apiDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.resolve(apiDirectory, '../../.env');

dotenv.config({ path: rootEnvPath });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
