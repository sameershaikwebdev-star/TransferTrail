import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
  getJwtAccessSecret,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '../config/auth.js';

const subjectSchema = z.string().uuid();

function rejectAuthentication(response) {
  response.status(401).json({ error: 'Authentication required' });
}

export function createAuthenticate(prismaClient) {
  return async function authenticate(request, response, next) {
    const authorization = request.get('authorization');
    const match = typeof authorization === 'string'
      ? /^Bearer\s+([^\s]+)$/i.exec(authorization)
      : null;

    if (!match) {
      rejectAuthentication(response);
      return;
    }

    let claims;
    try {
      claims = jwt.verify(match[1], getJwtAccessSecret(), {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      rejectAuthentication(response);
      return;
    }

    const subject = claims && typeof claims === 'object'
      ? subjectSchema.safeParse(claims.sub)
      : null;
    if (!subject?.success) {
      rejectAuthentication(response);
      return;
    }

    try {
      const user = await prismaClient.user.findUnique({
        where: { id: subject.data },
        select: { id: true, role: true, isActive: true, tokenVersion: true, fullName: true, email: true },
      });

      if (!user || !user.isActive) {
        rejectAuthentication(response);
        return;
      }

      if (claims.ver !== user.tokenVersion) {
        rejectAuthentication(response);
        return;
      }

      request.auth = { userId: user.id, role: user.role };
      next();
    } catch (error) {
      next(error);
    }
  };
}
