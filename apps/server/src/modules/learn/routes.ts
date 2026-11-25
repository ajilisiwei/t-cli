import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { ok } from '../../http/errors.ts';
import { UtcOffsetMinutes } from '../review/common.ts';
import type { ReviewLimits } from '../review/queue.ts';
import { learnSummary } from './summary.ts';

const SummaryQuery = z.object({ utcOffsetMinutes: UtcOffsetMinutes });

/**
 * 学习 tab (docs/api-v1.md, "v3 → Learn summary"):
 *   GET /v1/learn/summary?utcOffsetMinutes=   review counts by scope, the latest materials, the plan, the level
 */
export async function registerLearnRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config, db, clock } = deps;
  const authenticate = requireAuth(config.JWT_SECRET, clock, deps.db);
  const limits: ReviewLimits = { newPerDay: config.REVIEW_NEW_PER_DAY, reviewsPerDay: config.REVIEW_MAX_PER_DAY };

  app.get('/v1/learn/summary', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const { utcOffsetMinutes } = SummaryQuery.parse(request.query);
    return ok(await learnSummary(db, { userId, now: clock(), utcOffsetMinutes, limits }));
  });
}
