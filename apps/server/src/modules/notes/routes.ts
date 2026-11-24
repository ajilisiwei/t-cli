import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { notFound, ok } from '../../http/errors.ts';
import { localDateOf, mondayOf, startOfLocalDate } from '../review/common.ts';
import { deleteNote, listNotes, noteChanges, noteSummary, putNote } from './repo.ts';
import { DeleteNoteParams, ListNotesQuery, NoteChangesQuery, NoteSummaryQuery, PutNoteBody, PutNoteParams } from './schemas.ts';

/** A sentence and its translation (2 × 2000 code points) fit with room to spare. */
const PUT_BODY_LIMIT = 64 * 1024;

/**
 * The notebook (笔记本, docs/api-v1.md, "v2 → Notes"):
 *   PUT    /v1/notes/:id           save or update a note (idempotent by the client's ULID)
 *   DELETE /v1/notes/:id           取消收藏 (soft delete)
 *   GET    /v1/notes               live notes, newest first: ?kind=&stars=&before=&limit=
 *   GET    /v1/notes/changes       incremental sync: ?after=<seq>&limit=<n>
 *   GET    /v1/notes/summary       counts by kind and level: ?utcOffsetMinutes=
 *
 * Logs carry ids, kinds, stars and outcomes — never the note's text.
 */
export async function registerNotesRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, clock, config } = deps;
  const authenticate = requireAuth(config.JWT_SECRET, clock, db);
  const writeOptions = () => ({ now: clock(), masteredDays: config.MASTERED_DAYS });

  app.put('/v1/notes/:id', { preHandler: authenticate, bodyLimit: PUT_BODY_LIMIT }, async (request) => {
    const { userId } = authOf(request);
    const { id } = PutNoteParams.parse(request.params);
    const input = PutNoteBody.parse(request.body);
    const { note, outcome } = await putNote(db, userId, id, input, writeOptions());
    request.log.info({ userId, noteId: id, kind: note.kind, stars: note.stars, itemId: note.itemId, seq: note.seq, outcome }, 'note saved');
    return ok({ note });
  });

  app.delete('/v1/notes/:id', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const { id } = DeleteNoteParams.parse(request.params);
    const result = await deleteNote(db, userId, id, writeOptions());
    request.log.info({ userId, noteId: id, outcome: result?.outcome ?? 'not_found' }, 'note deleted');
    if (!result) throw notFound('note');
    return ok({ note: result.note });
  });

  app.get('/v1/notes', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    return ok(await listNotes(db, userId, ListNotesQuery.parse(request.query)));
  });

  app.get('/v1/notes/changes', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    return ok(await noteChanges(db, userId, NoteChangesQuery.parse(request.query)));
  });

  app.get('/v1/notes/summary', { preHandler: authenticate }, async (request) => {
    const { userId } = authOf(request);
    const { utcOffsetMinutes } = NoteSummaryQuery.parse(request.query);
    const weekStart = startOfLocalDate(mondayOf(localDateOf(clock(), utcOffsetMinutes)), utcOffsetMinutes);
    return ok(await noteSummary(db, userId, weekStart));
  });
}
