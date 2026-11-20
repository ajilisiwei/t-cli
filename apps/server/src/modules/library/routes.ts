import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { notFound, ok } from '../../http/errors.ts';
import { IdParams, LocalDate, UtcOffsetMinutes } from '../review/common.ts';
import { getItemDetail, listItems } from './items.ts';
import { getMaterial, listMaterialDates, type MaterialKind } from './materials.ts';
import { learningStats } from './stats.ts';

export const ITEMS_MAX_LIMIT = 50;
export const MATERIALS_MAX_LIMIT = 60;
export const STATS_MAX_DAYS = 366;
const SEARCH_MAX_CHARS = 64;
const OFFSET_MAX = 100_000;

const MaterialQuery = z.object({ date: LocalDate.optional() });
const MaterialListQuery = z.object({
  kind: z.enum(['daily', 'weekly']),
  before: LocalDate.optional(),
  limit: z.coerce.number().int().min(1).max(MATERIALS_MAX_LIMIT).default(30),
});
const ItemsQuery = z.object({
  // An empty search box means "no search".
  q: z.string().trim().max(SEARCH_MAX_CHARS).optional().transform((value) => (value === '' ? undefined : value)),
  type: z.enum(['word', 'phrase', 'grammar']).optional(),
  level: z.enum(['new', 'learning', 'mastered']).optional(),
  offset: z.coerce.number().int().min(0).max(OFFSET_MAX).default(0),
  limit: z.coerce.number().int().min(1).max(ITEMS_MAX_LIMIT).default(20),
});
const StatsQuery = z.object({
  days: z.coerce.number().int().min(1).max(STATS_MAX_DAYS).default(120),
  utcOffsetMinutes: UtcOffsetMinutes,
});

/**
 * How a search request is logged: the default serializer logs `req.url`
 * with its query string, and `q` is the user's own text.
 */
const SEARCH_LOG_SERIALIZERS = {
  req: (request: FastifyRequest) => ({ method: request.method, url: request.url.split('?')[0], host: request.host, remoteAddress: request.ip }),
};

/**
 * Materials, 词库 and statistics (docs/api-v1.md, "Materials", "Library and stats"):
 *   GET /v1/materials/daily?date=       one daily material (latest without date)
 *   GET /v1/materials/weekly?date=      one weekly report (date = the week's Monday)
 *   GET /v1/materials?kind=&before=     dates with material, newest first
 *   GET /v1/items?q=&type=&level=       learning units, searchable
 *   GET /v1/items/:id                   one unit with its cards and sources
 *   GET /v1/stats?days=                 activity heatmap, streak, retention, totals
 *
 * Read only. Logs never carry the search text.
 */
export async function registerLibraryRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, clock } = deps;
  const authenticate = requireAuth(deps.config.JWT_SECRET, clock);

  const materialRoute = (kind: MaterialKind) => async (request: FastifyRequest) => {
    const { userId } = authOf(request);
    const { date } = MaterialQuery.parse(request.query);
    const material = await getMaterial(db, userId, kind, date);
    if (!material) throw notFound(`${kind} material`);
    return ok(material);
  };
  app.get('/v1/materials/daily', { preHandler: authenticate }, materialRoute('daily'));
  app.get('/v1/materials/weekly', { preHandler: authenticate }, materialRoute('weekly'));

  app.get('/v1/materials', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const query = MaterialListQuery.parse(request.query);
    return ok(await listMaterialDates(db, userId, query));
  });

  app.get('/v1/items', { preHandler: authenticate, logSerializers: SEARCH_LOG_SERIALIZERS }, async (request) => {
    const { userId } = authOf(request);
    const query = ItemsQuery.parse(request.query);
    const page = await listItems(db, userId, query);
    request.log.info({ userId, search: query.q !== undefined, results: page.items.length }, 'items listed');
    return ok(page);
  });

  app.get('/v1/items/:id', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const { id } = IdParams.parse(request.params);
    const item = await getItemDetail(db, userId, id);
    if (!item) throw notFound('item');
    return ok(item);
  });

  app.get('/v1/stats', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const query = StatsQuery.parse(request.query);
    return ok(await learningStats(db, { userId, now: clock(), utcOffsetMinutes: query.utcOffsetMinutes, days: query.days }));
  });
}
