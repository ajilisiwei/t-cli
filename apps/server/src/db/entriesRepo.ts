import { and, asc, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import type { Entry } from '@t-cli/core/entry';
import { AppError } from '../http/errors.ts';
import type { Executor } from './client.ts';
import { entries, users } from './schema.ts';

/** An entry as stored on the server: the client Entry plus its sync position. */
export type SyncedEntry = Entry & { seq: number };

const OFFSET_RE = /(Z|([+-])(\d{2}):(\d{2}))$/;

/** UTC offset in minutes of an ISO 8601 string ("…+08:00" → 480, "…Z" → 0). */
export function offsetMinutesOf(iso: string): number {
  const match = OFFSET_RE.exec(iso);
  if (!match || match[1] === 'Z') return 0;
  const sign = match[2] === '-' ? -1 : 1;
  return sign * (Number(match[3]) * 60 + Number(match[4]));
}

/** Rebuild the client's ISO string (second precision) from an instant and its offset. */
export function toIsoWithOffset(instant: Date, offsetMinutes: number): string {
  const local = new Date(instant.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${local.toISOString().slice(0, 19)}${sign}${pad(Math.trunc(abs / 60))}:${pad(abs % 60)}`;
}

function toRow(userId: string, entry: Entry, seq: number): typeof entries.$inferInsert {
  return {
    userId,
    id: entry.id,
    seq,
    source: entry.source,
    task: entry.task,
    kind: entry.kind,
    input: entry.input,
    output: entry.output,
    srcLang: entry.srcLang,
    mode: entry.mode,
    correctedInput: entry.correctedInput ?? null,
    createdAt: new Date(entry.createdAt),
    utcOffsetMinutes: offsetMinutesOf(entry.createdAt),
  };
}

function fromRow(row: typeof entries.$inferSelect): SyncedEntry {
  return {
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
  };
}

/**
 * Store a batch of validated entries for one account, idempotently.
 *
 * Takes the account row's lock first, so writers for the same account run one
 * at a time: sequence numbers are allocated and committed in the same order,
 * and a reader paging by `seq > cursor` can never skip a row that commits
 * late. Entries whose id already exists are acknowledged but not rewritten.
 *
 * @returns accepted: every id in the batch (new or already stored), so the
 *   client can drop them from its outbox; inserted: how many were new.
 */
export async function insertEntries(
  db: Executor,
  userId: string,
  batch: readonly Entry[],
): Promise<{ accepted: string[]; inserted: number; lastSeq: number }> {
  const unique = [...new Map(batch.map((entry) => [entry.id, entry])).values()];
  const ids = unique.map((entry) => entry.id);

  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ lastSeq: users.lastSeq })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .for('update');
    if (!account) throw new AppError(404, 'NOT_FOUND', 'account not found');
    if (unique.length === 0) return { accepted: [], inserted: 0, lastSeq: account.lastSeq };

    const stored = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.userId, userId), inArray(entries.id, ids)));
    const storedIds = new Set(stored.map((row) => row.id));
    const fresh = unique.filter((entry) => !storedIds.has(entry.id));
    if (fresh.length === 0) return { accepted: ids, inserted: 0, lastSeq: account.lastSeq };

    const lastSeq = account.lastSeq + fresh.length;
    await tx.update(users).set({ lastSeq }).where(eq(users.id, userId));
    await tx.insert(entries).values(fresh.map((entry, i) => toRow(userId, entry, account.lastSeq + 1 + i)));
    return { accepted: ids, inserted: fresh.length, lastSeq };
  });
}

/** Page through an account's entries in sync order (`seq > after`). */
export async function listEntriesAfter(
  db: Executor,
  userId: string,
  { after, limit }: { after: number; limit: number },
): Promise<{ entries: SyncedEntry[]; nextAfter: number; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(entries)
    .where(and(eq(entries.userId, userId), gt(entries.seq, after)))
    .orderBy(asc(entries.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map(fromRow);
  return {
    entries: page,
    nextAfter: page.length > 0 ? page[page.length - 1]!.seq : after,
    hasMore: rows.length > limit,
  };
}

/**
 * Browse an account's entries newest first (`seq < before`, or from the
 * newest when `before` is absent). `nextBefore` is the cursor for the next
 * page, null once there is nothing older.
 */
export async function listEntriesBefore(
  db: Executor,
  userId: string,
  { before, limit }: { before?: number | undefined; limit: number },
): Promise<{ entries: SyncedEntry[]; nextBefore: number | null; hasMore: boolean }> {
  const scope = before === undefined ? eq(entries.userId, userId) : and(eq(entries.userId, userId), lt(entries.seq, before));
  const rows = await db.select().from(entries).where(scope).orderBy(desc(entries.seq)).limit(limit + 1);
  const page = rows.slice(0, limit).map(fromRow);
  const hasMore = rows.length > limit;
  return { entries: page, nextBefore: hasMore ? page[page.length - 1]!.seq : null, hasMore };
}

/** One of the account's entries by id; null when it does not exist or belongs to another account. */
export async function getEntry(db: Executor, userId: string, id: string): Promise<SyncedEntry | null> {
  const [row] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.userId, userId), eq(entries.id, id)));
  return row ? fromRow(row) : null;
}
