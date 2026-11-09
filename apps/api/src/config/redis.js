import { createClient } from 'redis';
import { validateRuntimeConfig } from './runtime.js';

const pendingConnections = new WeakMap();

export function createRedisClient(url, options = {}) {
  const parsed = new URL(url);
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }

  const client = createClient({
    url,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => (retries > 5 ? new Error('Redis reconnect limit reached') : Math.min(100 * (2 ** retries), 2000)),
      ...options.socket,
    },
  });
  client.on('error', (error) => {
    console.error('Redis client error', { name: error?.name ?? 'Error' });
  });
  return client;
}

export async function connectRedisClient(client = redisClient) {
  if (client.isReady) return;
  let connection = pendingConnections.get(client);
  if (connection) return connection;
  if (client.isOpen) throw new Error('Redis is unavailable; authentication rate limiting cannot run');
  if (!connection) {
    connection = client.connect()
      .then(() => {
        if (!client.isReady) throw new Error('Redis connection is not ready');
      })
      .catch(() => {
        throw new Error('Redis is unavailable; authentication rate limiting cannot start');
      })
      .finally(() => pendingConnections.delete(client));
    pendingConnections.set(client, connection);
  }
  await connection;
}

export function requireRedisReady(client) {
  return async (_request, _response, next) => {
    try {
      await connectRedisClient(client);
      next();
    } catch (error) {
      if (!Number.isInteger(error?.status)) error.status = 503;
      next(error);
    }
  };
}

export function createRateLimitSendCommand(client) {
  return async (...command) => {
    try {
      await connectRedisClient(client);
      return await client.sendCommand(command);
    } catch {
      const error = new Error('Authentication rate limit store unavailable');
      error.status = 503;
      throw error;
    }
  };
}

export const redisClient = createRedisClient(validateRuntimeConfig().redisUrl);
