import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { AppError, ok, unauthorized } from '../../http/errors.ts';
import { reminderConfig } from './config.ts';
import { addGrant } from './grants.ts';

const GrantBody = z.object({ templateId: z.string().trim().min(1).max(128) });

/**
 * Reminders (docs/api-v1.md, "Reminders"):
 *   GET  /v1/notify/config   the reminder template (null → reminders off)
 *   POST /v1/notify/grant    one `accept` from wx.requestSubscribeMessage
 */
export async function registerNotifyRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, clock } = deps;
  const authenticate = requireAuth(deps.config.JWT_SECRET, clock, deps.db);
  const reminder = reminderConfig(deps.config);

  app.get('/v1/notify/config', { preHandler: authenticate }, async () => ok({ reminderTemplateId: reminder?.templateId ?? null }));

  app.post('/v1/notify/grant', { preHandler: authenticate, bodyLimit: 4 * 1024 }, async (request) => {
    const { userId } = authOf(request);
    const { templateId } = GrantBody.parse(request.body);
    if (!reminder || templateId !== reminder.templateId) {
      request.log.info({ userId, outcome: 'unknown_template' }, 'notify grant');
      throw new AppError(400, 'VALIDATION_FAILED', 'request validation failed', [
        { path: 'templateId', message: 'not the configured reminder template' },
      ]);
    }
    const available = await addGrant(db, { userId, templateId, now: clock() });
    if (available === null) throw unauthorized('account not found');
    request.log.info({ userId, available, outcome: 'granted' }, 'notify grant');
    return ok({ available });
  });
}
