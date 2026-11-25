import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import type { Executor } from '../../db/client.ts';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { AppError } from '../../http/errors.ts';
import { createRateLimiter } from '../../lib/rateLimit.ts';
import { enforceRateLimit, localDateOf, localDay } from '../review/common.ts';
import { cardsDocument, checklistDocument, materialDocument, type DocumentOptions } from './assemble.ts';
import type { LoadedMaterial } from './content.ts';
import type { PdfDocument } from './document.ts';
import { contentDisposition, exportFileName } from './filename.ts';
import { checklistUnits, loadMaterials, materialParts, wordNotes } from './repo.ts';
import { createTypstRenderer, RenderFailedError, RendererUnavailableError, type PdfRenderer, type RenderResult } from './renderer.ts';
import { PdfExportBody, type PdfExportRequest } from './request.ts';

/**
 * PDF export (docs/api-v1.md, "v3 → PDF export"; docs/v3-plan.html §8):
 *
 *   POST /v1/exports/pdf → application/pdf (学习资料, 合集, 单词卡, 自测清单)
 *
 * Order of checks: auth → validation → 10 per account per hour → materials
 * (404) → render (503 not installed, 502 failed or > 15 s) → at most 40
 * pages (422). The PDF is streamed back and never stored. Logs carry the
 * scope, counts, pages, timings and the outcome — never any content.
 */

export const PDF_EXPORTS_PER_HOUR = 10;
export const MAX_PDF_PAGES = 40;
const HOUR_MS = 3_600_000;

export interface ExportRouteOptions {
  /** Tests inject a fake; by default Typst from TYPST_BIN / TYPST_FONT_PATH. */
  renderer?: PdfRenderer;
}

const itemIdsOf = (materials: readonly LoadedMaterial[]): string[] =>
  materials.flatMap((material) =>
    material.kind === 'extend' ? [] : [...material.content.words, ...material.content.phrases].map((unit) => unit.itemId),
  );

async function loadOrThrow(db: Executor, userId: string, body: PdfExportRequest): Promise<LoadedMaterial[]> {
  if (!body.materials) return [];
  const loaded = await loadMaterials(db, userId, body.materials);
  if (!loaded.ok) throw new AppError(404, 'NOT_FOUND', 'material not found', { missing: loaded.missing });
  return loaded.materials;
}

async function documentFor(db: Executor, userId: string, body: PdfExportRequest, now: Date): Promise<PdfDocument> {
  const today = localDateOf(now, body.utcOffsetMinutes);
  const options: DocumentOptions = { layout: body.layout, ipa: body.ipa, large: body.large, today };
  const materials = await loadOrThrow(db, userId, body);
  if (body.scope === 'cards') return cardsDocument(materials, options);
  if (body.scope === 'checklist') {
    if (materials.length > 0) return checklistDocument({ from: 'materials', materials }, options);
    const rows = await checklistUnits(db, userId, { now, endOfToday: localDay(today, body.utcOffsetMinutes).end });
    return checklistDocument({ from: 'units', rows }, options);
  }
  const [parts, notes] = await Promise.all([materialParts(db, userId), wordNotes(db, userId, itemIdsOf(materials), now)]);
  return materialDocument(materials, { ...options, parts, notes });
}

export async function registerExportRoutes(app: FastifyInstance, deps: AppDeps, options: ExportRouteOptions = {}): Promise<void> {
  const { config, db, clock } = deps;
  const authenticate = requireAuth(config.JWT_SECRET, clock, db);
  const perHour = createRateLimiter({ limit: PDF_EXPORTS_PER_HOUR, windowMs: HOUR_MS });
  const renderer = options.renderer ?? createTypstRenderer({ bin: config.TYPST_BIN, fontPath: config.TYPST_FONT_PATH });

  app.post('/v1/exports/pdf', { preHandler: authenticate, bodyLimit: 4 * 1024 }, async (request, reply) => {
    const startedAt = performance.now();
    const { userId } = authOf(request);
    const body = PdfExportBody.parse(request.body);
    const log = (level: 'info' | 'warn', outcome: string, extra: Record<string, unknown> = {}): void => {
      const totalMs = Math.round(performance.now() - startedAt);
      const shape = { scope: body.scope, materials: body.materials?.length ?? 0, layout: body.layout, large: body.large };
      request.log[level]({ userId, ...shape, ...extra, totalMs, outcome }, 'pdf export');
    };

    try {
      enforceRateLimit(perHour, userId, clock(), reply, 'too many PDF exports, try again later');
    } catch (error) {
      log('info', 'rate_limited');
      throw error;
    }

    const now = clock();
    const document = await documentFor(db, userId, body, now).catch((error: unknown) => {
      if (error instanceof AppError && error.statusCode === 404) log('info', 'not_found');
      throw error;
    });

    let result: RenderResult;
    try {
      result = await renderer.render(document);
    } catch (error) {
      if (error instanceof RendererUnavailableError) {
        log('warn', 'unavailable');
        throw new AppError(503, 'EXPORT_UNAVAILABLE', 'the PDF renderer is not installed');
      }
      if (error instanceof RenderFailedError) {
        log('warn', 'render_failed', { reason: error.reason });
        throw new AppError(502, 'EXPORT_FAILED', 'the PDF could not be rendered');
      }
      throw error;
    }

    const timings = { pages: result.pages, bytes: result.pdf.byteLength, queueMs: result.queueMs, renderMs: result.renderMs };
    if (result.pages > MAX_PDF_PAGES) {
      log('info', 'too_many_pages', timings);
      throw new AppError(422, 'TOO_MANY_PAGES', `the PDF would have ${result.pages} pages, at most ${MAX_PDF_PAGES} are allowed`, { pages: result.pages });
    }
    log('info', 'ok', timings);
    const fileName = exportFileName(body.scope, body.materials?.map((ref) => ref.date) ?? [], localDateOf(now, body.utcOffsetMinutes));
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', contentDisposition(fileName))
      .header('x-pdf-pages', String(result.pages))
      .header('cache-control', 'no-store')
      .send(result.pdf);
  });
}
