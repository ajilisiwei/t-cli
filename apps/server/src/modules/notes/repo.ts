import { and, asc, desc, eq, getTableColumns, gt, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Database, Executor } from '../../db/client.ts';
import { notes, users } from '../../db/schema.ts';
import { AppError, notFound } from '../../http/errors.ts';
import { toSettings } from '../auth/settings.ts';
import { LEVEL_SQL, type ItemLevel } from '../library/items.ts';
import type { ExplanationLang } from '../pipeline/schemas.ts';
import { linkItem, refreshStars } from './items.ts';
import type { ListNotesQuery, NoteInput, NoteKind, NoteStars } from './schemas.ts';

/**
 * The notebook's data access (docs/api-v1.md, "v2 → Notes"). Every query
 * filters on the account's user_id.
 *
 * Writes take the account row's lock first: a note's `seq` is max(seq) + 1
 * allocated under it, so seq order equals commit order and a `changes`
 * cursor never skips a write. The item link and `items.stars` change in the
 * same transaction as the note.
 */

/** A note as the API shows it; `level` and `task` are derived at read time (they never bump `seq`). */
export interface NoteView {
  id: string;
  kind: NoteKind;
  text: string;
  translation: string | null;
  lang: string;
  stars: NoteStars;
  lemma: string | null;
  entryId: string | null;
  itemId: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** The learning level of its item (as `GET /v1/items` derives it); null without an item. */
  level: ItemLevel | null;
  /** The task of its source record; null without `entryId` or before that record was pushed. */
  task: 'translate' | 'check' | null;
}

export type PutOutcome = 'created' | 'updated' | 'revived' | 'unchanged';

export interface WriteOptions {
  now: Date;
  masteredDays: number;
}

// The two correlated subqueries below name their columns explicitly: in the
// select list of a single-table query drizzle renders column references
// without their table, and an unqualified "user_id" inside the subquery would
// bind to the inner table instead of the note.

/** The item's level: the library's aggregate over its cards (LEVEL_SQL), as a scalar subquery per note. */
const levelSql = sql<ItemLevel | null>`(case when "notes"."item_id" is null then null else
  (select ${LEVEL_SQL} from "cards" where "cards"."user_id" = "notes"."user_id" and "cards"."item_id" = "notes"."item_id") end)`;

/** The source record's task (the same account's record only). */
const taskSql = sql<'translate' | 'check' | null>`(select "entries"."task" from "entries"
  where "entries"."user_id" = "notes"."user_id" and "entries"."id" = "notes"."entry_id")`;

const viewColumns = { ...getTableColumns(notes), level: levelSql, task: taskSql };

type ViewRow = typeof notes.$inferSelect & { level: ItemLevel | null; task: 'translate' | 'check' | null };

function toView(row: ViewRow): NoteView {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    translation: row.translation,
    lang: row.lang,
    stars: row.stars as NoteStars,
    lemma: row.lemma,
    entryId: row.entryId,
    itemId: row.itemId,
    seq: row.seq,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    level: row.level,
    task: row.task,
  };
}

async function selectViews(db: Executor, where: SQL | undefined, order: SQL[], limit: number): Promise<NoteView[]> {
  const rows = await db.select(viewColumns).from(notes).where(where).orderBy(...order).limit(limit);
  return rows.map(toView);
}

async function readNote(db: Executor, userId: string, id: string): Promise<NoteView> {
  const [view] = await selectViews(db, and(eq(notes.userId, userId), eq(notes.id, id)), [asc(notes.id)], 1);
  if (!view) throw new Error('note vanished inside its transaction');
  return view;
}

interface AccountLock {
  explanationLang: ExplanationLang;
  importanceReview: boolean;
}

/** Lock the account row (serialises the account's note writes) and read the settings the write needs. */
async function lockAccount(tx: Executor, userId: string): Promise<AccountLock> {
  const [account] = await tx
    .select({ settings: users.settings })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .for('update');
  if (!account) throw notFound('account');
  const settings = toSettings(account.settings);
  return { explanationLang: settings.explanationLang ?? 'zh', importanceReview: settings.importanceReview ?? true };
}

/** The account's next note seq (under the account lock). */
async function nextSeq(tx: Executor, userId: string): Promise<number> {
  const [row] = await tx
    .select({ last: sql<number>`coalesce(max(${notes.seq}), 0)::bigint` })
    .from(notes)
    .where(eq(notes.userId, userId));
  return Number(row?.last ?? 0) + 1;
}

type StoredNote = typeof notes.$inferSelect;

/** The stored note after applying `input` (409 when kind, text or lang differ). */
function merged(stored: StoredNote, input: NoteInput): Pick<StoredNote, 'stars' | 'translation' | 'entryId' | 'lemma'> {
  if (stored.kind !== input.kind || stored.text !== input.text || stored.lang !== input.lang) {
    throw new AppError(409, 'NOTE_CONFLICT', 'the note exists with another kind, text or lang');
  }
  return {
    stars: input.stars,
    translation: input.translation ?? stored.translation,
    entryId: input.entryId ?? stored.entryId,
    lemma: input.kind === 'sentence' ? null : (input.lemma ?? stored.lemma),
  };
}

const isUnchanged = (stored: StoredNote, next: ReturnType<typeof merged>): boolean =>
  stored.deletedAt === null &&
  stored.stars === next.stars &&
  stored.translation === next.translation &&
  stored.entryId === next.entryId &&
  stored.lemma === next.lemma;

/**
 * `PUT /v1/notes/:id`: create, update or revive the note, link its item and
 * refresh the stars of the items it feeds (and fed, when the lemma moved it).
 */
export async function putNote(
  db: Database,
  userId: string,
  id: string,
  input: NoteInput,
  { now, masteredDays }: WriteOptions,
): Promise<{ note: NoteView; outcome: PutOutcome }> {
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, userId);
    const [stored] = await tx.select().from(notes).where(and(eq(notes.userId, userId), eq(notes.id, id)));
    const next = stored
      ? merged(stored, input)
      : { stars: input.stars, translation: input.translation ?? null, entryId: input.entryId ?? null, lemma: input.lemma ?? null };
    if (stored && isUnchanged(stored, next)) return { note: await readNote(tx, userId, id), outcome: 'unchanged' };

    const itemId = await linkItem(tx, { userId, explanationLang: account.explanationLang, now }, {
      kind: input.kind,
      text: input.text,
      translation: next.translation,
      lemma: next.lemma,
    });
    const seq = await nextSeq(tx, userId);
    if (stored) {
      await tx
        .update(notes)
        .set({ ...next, itemId, seq, updatedAt: now, deletedAt: null })
        .where(and(eq(notes.userId, userId), eq(notes.id, id)));
    } else {
      await tx.insert(notes).values({ userId, id, kind: input.kind, text: input.text, lang: input.lang, ...next, itemId, seq, createdAt: now, updatedAt: now });
    }

    const starContext = { userId, now, importanceReview: account.importanceReview, masteredDays };
    for (const touched of new Set([itemId, stored?.itemId ?? itemId])) await refreshStars(tx, starContext, touched);
    const outcome: PutOutcome = !stored ? 'created' : stored.deletedAt ? 'revived' : 'updated';
    return { note: await readNote(tx, userId, id), outcome };
  });
}

/**
 * `DELETE /v1/notes/:id` (取消收藏): soft delete with a new seq, and the
 * item's stars recomputed. The item, its cards and their history stay.
 * Null when the account has no such note; an already deleted note comes back
 * as it is.
 */
export async function deleteNote(
  db: Database,
  userId: string,
  id: string,
  { now, masteredDays }: WriteOptions,
): Promise<{ note: NoteView; outcome: 'deleted' | 'already_deleted' } | null> {
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, userId);
    const [stored] = await tx.select().from(notes).where(and(eq(notes.userId, userId), eq(notes.id, id)));
    if (!stored) return null;
    if (stored.deletedAt) return { note: await readNote(tx, userId, id), outcome: 'already_deleted' };

    const seq = await nextSeq(tx, userId);
    await tx
      .update(notes)
      .set({ deletedAt: now, seq, updatedAt: now })
      .where(and(eq(notes.userId, userId), eq(notes.id, id)));
    if (stored.itemId) {
      await refreshStars(tx, { userId, now, importanceReview: account.importanceReview, masteredDays }, stored.itemId);
    }
    return { note: await readNote(tx, userId, id), outcome: 'deleted' };
  });
}

/** `GET /v1/notes`: live notes newest first (by id), filtered by kind and stars. */
export async function listNotes(
  db: Executor,
  userId: string,
  { kind, stars, before, limit }: ListNotesQuery,
): Promise<{ notes: NoteView[]; nextBefore: string | null; hasMore: boolean }> {
  const where = and(
    eq(notes.userId, userId),
    isNull(notes.deletedAt),
    kind === undefined ? undefined : eq(notes.kind, kind),
    stars === undefined ? undefined : eq(notes.stars, stars),
    before === undefined ? undefined : lt(notes.id, before),
  );
  const rows = await selectViews(db, where, [desc(notes.id)], limit + 1);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { notes: page, nextBefore: hasMore ? page[page.length - 1]!.id : null, hasMore };
}

/** `GET /v1/notes/changes`: every note changed after `after` (deleted ones included), by seq. */
export async function noteChanges(
  db: Executor,
  userId: string,
  { after, limit }: { after: number; limit: number },
): Promise<{ notes: NoteView[]; nextAfter: number; hasMore: boolean }> {
  const rows = await selectViews(db, and(eq(notes.userId, userId), gt(notes.seq, after)), [asc(notes.seq)], limit + 1);
  const page = rows.slice(0, limit);
  return { notes: page, nextAfter: page.length > 0 ? page[page.length - 1]!.seq : after, hasMore: rows.length > limit };
}

export interface NoteSummary {
  total: number;
  thisWeek: number;
  kinds: Record<NoteKind, number>;
  levels: Record<ItemLevel, number>;
}

/**
 * `GET /v1/notes/summary`: live notes by kind and by their item's level, and
 * how many were created since `weekStart` (the caller's local Monday).
 * Notes without an item count in `total` and `kinds` only.
 */
export async function noteSummary(db: Executor, userId: string, weekStart: Date): Promise<NoteSummary> {
  const rows = await db
    .select({
      kind: notes.kind,
      level: levelSql,
      count: sql<number>`count(*)::int`,
      thisWeek: sql<number>`(count(*) filter (where ${notes.createdAt} >= ${weekStart.toISOString()}::timestamptz))::int`,
    })
    .from(notes)
    .where(and(eq(notes.userId, userId), isNull(notes.deletedAt)))
    .groupBy(sql`1`, sql`2`);
  const summary: NoteSummary = {
    total: 0,
    thisWeek: 0,
    kinds: { word: 0, phrase: 0, sentence: 0 },
    levels: { new: 0, learning: 0, mastered: 0 },
  };
  return rows.reduce<NoteSummary>(
    (acc, row) => ({
      total: acc.total + row.count,
      thisWeek: acc.thisWeek + row.thisWeek,
      kinds: { ...acc.kinds, [row.kind]: acc.kinds[row.kind] + row.count },
      levels: row.level === null ? acc.levels : { ...acc.levels, [row.level]: acc.levels[row.level] + row.count },
    }),
    summary,
  );
}
