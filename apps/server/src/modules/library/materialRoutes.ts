import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { notFound, ok, unauthorized } from '../../http/errors.ts';
import { adoptExtendItems, dismissExtend, knownFlags } from '../learn/extendActions.ts';
import { explanationLangOf } from '../lookup/repo.ts';
import { LocalDate, UtcOffsetMinutes } from '../review/common.ts';
import { extendItemsOf, toListItem, toMaterialResponse } from './materialView.ts';
import { getMaterialRow, listMaterials, MATERIAL_KINDS, setMaterialRead, type MaterialKind } from './materials.ts';

export const MATERIALS_MAX_LIMIT = 60;
/** Extension items a material can have (ExtendContentSchema: 6–10). */
export const ADOPT_MAX_INDEXES = 10;

const MaterialQuery = z.object({ date: LocalDate.optional() });
const MaterialListQuery = z.object({
  kind: z.enum(['all', ...MATERIAL_KINDS]),
  before: LocalDate.optional(),
  limit: z.coerce.number().int().min(1).max(MATERIALS_MAX_LIMIT).default(30),
});
const MaterialParams = z.object({ kind: z.enum(MATERIAL_KINDS), date: LocalDate });
const DateParams = z.object({ date: LocalDate });
const ReadBody = z.strictObject({ read: z.boolean() });
const AdoptBody = z.strictObject({
  indexes: z
    .array(z.number().int().min(0).max(ADOPT_MAX_INDEXES - 1))
    .min(1)
    .max(ADOPT_MAX_INDEXES)
    .refine((indexes) => new Set(indexes).size === indexes.length, 'must be distinct'),
});
const DismissBody = z.strictObject({ undo: z.boolean().optional(), utcOffsetMinutes: UtcOffsetMinutes });

/**
 * Materials (docs/api-v1.md, "Materials" and "v3 → Materials"):
 *   GET  /v1/materials?kind=&before=&limit=      dates and list items, newest first
 *   GET  /v1/materials/{daily,digest,extend,weekly}?date=   one material (latest without date)
 *   POST /v1/materials/:kind/:date/read          学完了 / undo
 *   POST /v1/materials/extend/:date/adopt        add chosen extension items as units
 *   POST /v1/materials/extend/:date/dismiss      不感兴趣: mute the topic for 30 days
 *
 * Logs carry ids, kinds, dates and counts only.
 */
export async function registerMaterialRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, clock } = deps;
  const authenticate = requireAuth(deps.config.JWT_SECRET, clock, deps.db);

  const languageOf = async (userId: string) => {
    const lang = await explanationLangOf(db, userId);
    if (lang === null) throw unauthorized('account not found');
    return lang;
  };

  const materialRoute = (kind: MaterialKind) => async (request: FastifyRequest) => {
    const { userId } = authOf(request);
    const { date } = MaterialQuery.parse(request.query);
    const row = await getMaterialRow(db, userId, kind, date);
    if (!row) throw notFound(`${kind} material`);
    const known = kind === 'extend' ? await knownFlags(db, userId, extendItemsOf(row.content)) : undefined;
    return ok(toMaterialResponse(row, known));
  };
  for (const kind of MATERIAL_KINDS) app.get(`/v1/materials/${kind}`, { preHandler: authenticate }, materialRoute(kind));

  app.get('/v1/materials', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const query = MaterialListQuery.parse(request.query);
    const page = await listMaterials(db, userId, query);
    const lang = await languageOf(userId);
    return ok({ dates: page.dates, items: page.rows.map((row) => toListItem(row, lang)), nextBefore: page.nextBefore });
  });

  app.post('/v1/materials/:kind/:date/read', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const { kind, date } = MaterialParams.parse(request.params);
    const { read } = ReadBody.parse(request.body);
    const result = await setMaterialRead(db, userId, { kind, date, read, now: clock() });
    if (!result) throw notFound(`${kind} material`);
    request.log.info({ userId, kind, date, read }, 'material read mark');
    return ok({ readAt: result.readAt?.toISOString() ?? null });
  });

  app.post('/v1/materials/extend/:date/adopt', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const { date } = DateParams.parse(request.params);
    const { indexes } = AdoptBody.parse(request.body);
    const explanationLang = await languageOf(userId);
    const result = await adoptExtendItems(db, { userId, explanationLang, now: clock() }, { date, indexes });
    if (!result) throw notFound('extend material');
    request.log.info({ userId, date, added: result.added.length, known: result.known.length }, 'extension items adopted');
    return ok(result);
  });

  app.post('/v1/materials/extend/:date/dismiss', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const { date } = DateParams.parse(request.params);
    const body = DismissBody.parse(request.body ?? {});
    const result = await dismissExtend(db, { userId, date, undo: body.undo ?? false, now: clock(), utcOffsetMinutes: body.utcOffsetMinutes });
    if (!result) throw notFound('extend material');
    request.log.info({ userId, date, undo: body.undo ?? false, muted: result.extendMuted.length }, 'extension dismissed');
    return ok(result);
  });
}
