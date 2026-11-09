import { Router } from 'express';
import { z } from 'zod';
import { createAuthenticate } from '../middleware/authenticate.js';

const profileSchema = z.strictObject({ fullName: z.string().trim().min(1).max(100) });

export function createUsersRouter(prismaClient) {
  const router = Router();
  router.use(createAuthenticate(prismaClient));

  router.get('/me', async (request, response, next) => {
    try {
      const user = await prismaClient.user.findUnique({
        where: { id: request.auth.userId },
        select: { id: true, fullName: true, email: true, role: true, isActive: true, createdAt: true },
      });
      if (!user || !user.isActive) return response.status(401).json({ error: 'Authentication required' });
      return response.json({ user });
    } catch (error) { return next(error); }
  });

  router.patch('/me', async (request, response, next) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'A full name of 1 to 100 characters is required' });
    try {
      const [user] = await prismaClient.$queryRaw`
        SELECT * FROM public.update_user_profile(${request.auth.userId}::uuid, ${parsed.data.fullName}::text)
      `;
      return response.json({ user });
    } catch (error) { return next(error); }
  });

  return router;
}
