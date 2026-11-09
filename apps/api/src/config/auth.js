import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
dotenv.config({ path: path.join(repositoryRoot, '.env') });

export const JWT_ISSUER = 'balancevault-api';
export const JWT_AUDIENCE = 'balancevault-client';
export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;

export function getJwtAccessSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_ACCESS_SECRET must contain at least 32 bytes');
  }
  return secret;
}

export function validateAuthConfig() {
  getJwtAccessSecret();
  const actorKey = process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY;
  if (typeof actorKey !== 'string' || !/^(?:[a-f0-9]{2}){32,}$/i.test(actorKey)) {
    throw new Error('BALANCEVAULT_ACTOR_ASSERTION_KEY must be at least 32 bytes encoded as hex');
  }
}
