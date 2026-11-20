import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { validateEntry, type Entry } from '@t-cli/core/entry';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { insertEntries, listEntriesAfter, listEntriesBefore, toIsoWithOffset, type SyncedEntry } from '../../db/entriesRepo.ts';
import { entries } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { ok } from '../../http/errors.ts';
import { LocalDate, localDay, UtcOffsetMinutes } from '../review/common.ts';

export const PUSH_MAX_ENTRIES = 500;
export const PULL_MAX_LIMIT = 500;
export const HISTORY_MAX_LIMIT = 100;
/** Records returned for one local day (docs/api-v1.md, `GET /v1/entries/day`). */
export const DAY_MAX_ENTRIES = 500;
// Outputs of detail-mode paragraph translations can be long; anything far
// beyond these is not a real record.
const INPUT_MAX_CHARS = 20_000;
const OUTPUT_MAX_CHARS = 50_000;

const PushBody = z.object({
  entries: z.array(z.unknown()).min(1).max(PUSH_MAX_ENTRIES),
});

const PullQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(PULL_MAX_LIMIT).default(200),
});

const HistoryQuery = z.object({
  // Absent → start from the newest entry.
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).default(30),
});

const DayQuery = z.object({ date: LocalDate, utcOffsetMinutes: UtcOffsetMinutes });

type Rejection = { index: number; id: string | null; errors: string[] };

/** Validate each raw entry with the shared core schema; never trust the client. */
function partitionEntries(raw: readonly unknown[]): { valid: Entry[]; rejected: Rejection[] } {
  const valid: Entry[] = [];
  const rejected: Rejection[] = [];
  raw.forEach((value, index) => {
    const result = validateEntry(value);
    const id = value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : null;
    if (!result.ok) {
      rejected.push({ index, id, errors: result.errors });
      return;
    }
    const { entry } = result;
    if (entry.input.length > INPUT_MAX_CHARS || entry.output.length > OUTPUT_MAX_CHARS) {
      rejected.push({ index, id, errors: ['input or output too long'] });
      return;
    }
    valid.push(entry);
  });
  return { valid, rejected };
}

/**
 * The account's records made on one local day (at the caller's offset),
 * oldest first, at most DAY_MAX_ENTRIES.
 */
async function listEntriesOfDay(db: Executor, userId: string, { date, utcOffsetMinutes }: { date: string; utcOffsetMinutes: number }): Promise<SyncedEntry[]> {
  const day = localDay(date, utcOffsetMinutes);
  const rows = await db
    .select()
    .from(entries)
    .where(and(eq(entries.userId, userId), gte(entries.createdAt, day.start), lt(entries.createdAt, day.end)))
    .orderBy(asc(entries.createdAt), asc(entries.seq))
    .limit(DAY_MAX_ENTRIES);
  return rows.map((row) => ({
    v: 1,
    id: row.id,
    source: row.source,
    task: row.task,
    kind: row.kind,
    input: row.input,
    output: row.output,
    srcLang: row.srcLang,
    mode: row.mode,
    createdAt: toIsoWithOffset(row.createdAt, row.utcOffsetMinutes),
    correctedInput: row.correctedInput,
    seq: row.seq,
  }));
}

/**
 * Record sync.
 *   POST /v1/entries   push a batch (idempotent by entry id)
 *   GET  /v1/entries   pull in seq order: ?after=<seq>&limit=<n>
 *   GET  /v1/entries/history  browse newest first: ?before=<seq>&limit=<n>
 *   GET  /v1/entries/day      one local day, oldest first: ?date=YYYY-MM-DD&utcOffsetMinutes=<n>
 */
export async function registerSyncRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const authenticate = requireAuth(deps.config.JWT_SECRET, deps.clock);

  app.post('/v1/entries', { preHandler: authenticate, bodyLimit: 8 * 1024 * 1024 }, async (request) => {
    const { userId } = authOf(request);
    const body = PushBody.parse(request.body);
    const { valid, rejected } = partitionEntries(body.entries);
    const result = await insertEntries(deps.db, userId, valid);
    request.log.info({ userId, pushed: body.entries.length, inserted: result.inserted, rejected: rejected.length }, 'entries pushed');
    return ok({ accepted: result.accepted, rejected, lastSeq: result.lastSeq });
  });

  app.get('/v1/entries', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const query = PullQuery.parse(request.query);
    return ok(await listEntriesAfter(deps.db, userId, query));
  });

  app.get('/v1/entries/history', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const query = HistoryQuery.parse(request.query);
    return ok(await listEntriesBefore(deps.db, userId, query));
  });

  app.get('/v1/entries/day', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const query = DayQuery.parse(request.query);
    return ok({ entries: await listEntriesOfDay(deps.db, userId, query) });
  });
}
