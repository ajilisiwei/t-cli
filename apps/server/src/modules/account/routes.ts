import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { toIsoWithOffset } from '../../db/entriesRepo.ts';
import { users } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { loggableError, ok, unauthorized } from '../../http/errors.ts';
import { createRateLimiter } from '../../lib/rateLimit.ts';
import { isActiveAccount } from '../auth/accounts.ts';
import { registerNotifyRoutes } from '../notify/index.ts';
import { DEFAULT_UTC_OFFSET_MINUTES, enforceRateLimit, localDateOf, MINUTE_MS } from '../review/common.ts';
import { exportMarkdown, type ExportSummary } from './exportMarkdown.ts';

export const EXPORTS_PER_HOUR = 3;

const ExportBody = z.object({ utcOffsetMinutes: z.number().int().min(-720).max(840).optional() }).optional();
const ExportQuery = z.object({ utcOffsetMinutes: z.coerce.number().int().min(-720).max(840).optional() });
const DeleteBody = z.strictObject({ confirm: z.literal('DELETE') });

/**
 * Delete the account row; every table that holds the account's data
 * references it with ON DELETE CASCADE (identities, devices, entries, items,
 * cards, logs, materials, grants, quotas…). False when it was already gone.
 */
async function deleteAccount(db: Executor, userId: string): Promise<boolean> {
  const rows = await db
    .delete(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Account lifecycle (docs/api-v1.md, "Account"):
 *   POST /v1/export      all records and learning units as Markdown (3 per hour)
 *   POST /v1/me/delete   delete the account and all of its data
 * and the reminder routes (modules/notify), which live with the account.
 *
 * Logs carry ids, counts, sizes and timings — never the exported text.
 */
export async function registerAccountRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, clock } = deps;
  const authenticate = requireAuth(deps.config.JWT_SECRET, clock, deps.db);
  const exports = createRateLimiter({ limit: EXPORTS_PER_HOUR, windowMs: 60 * MINUTE_MS });

  app.post('/v1/export', { preHandler: authenticate, bodyLimit: 1024 }, async (request, reply) => {
    const { userId } = authOf(request);
    const body = ExportBody.parse(request.body ?? undefined);
    const query = ExportQuery.parse(request.query);
    const utcOffsetMinutes = body?.utcOffsetMinutes ?? query.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES;
    const now = clock();
    enforceRateLimit(exports, userId, now, reply, 'too many exports, try again later');
    if (!(await isActiveAccount(db, userId))) throw unauthorized('account not found');

    const startedAt = performance.now();
    const summary: ExportSummary = { entries: 0, items: 0 };
    let bytes = 0;
    async function* tracked(): AsyncGenerator<string> {
      let outcome = 'ok';
      try {
        for await (const chunk of exportMarkdown(db, { userId, exportedAt: toIsoWithOffset(now, utcOffsetMinutes), summary })) {
          bytes += Buffer.byteLength(chunk);
          yield chunk;
        }
      } catch (error) {
        outcome = 'failed';
        request.log.error({ userId, ...loggableError(error) }, 'export failed');
        throw error;
      } finally {
        request.log.info({ userId, ...summary, bytes, ms: Math.round(performance.now() - startedAt), outcome }, 'export');
      }
    }

    const fileDate = localDateOf(now, utcOffsetMinutes).replaceAll('-', '');
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="t-cli-export-${fileDate}.md"`)
      .header('cache-control', 'no-store')
      .send(Readable.from(tracked()));
  });

  app.post('/v1/me/delete', { preHandler: authenticate, bodyLimit: 1024 }, async (request) => {
    const { userId, deviceId } = authOf(request);
    DeleteBody.parse(request.body);
    if (!(await deleteAccount(db, userId))) throw unauthorized('account not found');
    request.log.info({ userId, deviceId, outcome: 'deleted' }, 'account deleted');
    return ok({ deleted: true });
  });

  await registerNotifyRoutes(app, deps);
}
