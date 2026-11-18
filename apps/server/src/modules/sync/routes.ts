import type { FastifyInstance } from 'fastify';
import { validateEntry, type Entry } from '@t-cli/core/entry';
import { z } from 'zod';
import { insertEntries, listEntriesAfter, listEntriesBefore } from '../../db/entriesRepo.ts';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { ok } from '../../http/errors.ts';

export const PUSH_MAX_ENTRIES = 500;
export const PULL_MAX_LIMIT = 500;
export const HISTORY_MAX_LIMIT = 100;
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
 * Record sync.
 *   POST /v1/entries   push a batch (idempotent by entry id)
 *   GET  /v1/entries   pull in seq order: ?after=<seq>&limit=<n>
 *   GET  /v1/entries/history  browse newest first: ?before=<seq>&limit=<n>
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
}
