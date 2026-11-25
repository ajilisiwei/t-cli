import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { materials } from '../../db/schema.ts';

/**
 * Stored materials (docs/api-v1.md, "Materials" and "v3 → Materials"): read
 * side and the "学完了" mark. Every query filters on the caller's user_id.
 */

export const MATERIAL_KINDS = ['daily', 'digest', 'extend', 'weekly'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

/** `GET /v1/materials?kind=`: every kind, 周期资料 (daily and digest), or one kind. */
export const LIST_KINDS = ['all', 'periodic', ...MATERIAL_KINDS] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** The kinds of 周期资料. */
export const PERIODIC_KINDS: readonly MaterialKind[] = ['daily', 'digest'];

const kindFilter = (kind: ListKind) => {
  if (kind === 'all') return undefined;
  if (kind === 'periodic') return inArray(materials.kind, [...PERIODIC_KINDS]);
  return eq(materials.kind, kind);
};

/** Within one date: extend, digest, daily, weekly (the contract's list order). */
export const KIND_ORDER: readonly MaterialKind[] = ['extend', 'digest', 'daily', 'weekly'];
const kindRank = sql<number>`case ${materials.kind} when 'extend' then 0 when 'digest' then 1 when 'daily' then 2 else 3 end`;

export interface MaterialRow {
  kind: MaterialKind;
  date: string;
  content: Record<string, unknown>;
  createdAt: Date;
  readAt: Date | null;
}

/** v1 view, kept for callers of the old shape. */
export interface MaterialView {
  date: string;
  content: Record<string, unknown>;
  createdAt: string;
}

const rowColumns = {
  kind: materials.kind,
  date: materials.date,
  content: materials.content,
  createdAt: materials.createdAt,
  readAt: materials.readAt,
};

/** The material of `date` (the week's Monday for weekly), or the latest one of `kind` when `date` is absent. */
export async function getMaterialRow(db: Executor, userId: string, kind: MaterialKind, date?: string): Promise<MaterialRow | null> {
  const [row] = await db
    .select(rowColumns)
    .from(materials)
    .where(and(eq(materials.userId, userId), eq(materials.kind, kind), date === undefined ? undefined : eq(materials.date, date)))
    .orderBy(desc(materials.date))
    .limit(1);
  return row ?? null;
}

/** v1 shape of getMaterialRow. */
export async function getMaterial(db: Executor, userId: string, kind: MaterialKind, date?: string): Promise<MaterialView | null> {
  const row = await getMaterialRow(db, userId, kind, date);
  return row ? { date: row.date, content: row.content, createdAt: row.createdAt.toISOString() } : null;
}

export interface MaterialPage {
  /** Each date once, newest first. */
  dates: string[];
  /** Every material on those dates: date desc, then KIND_ORDER. */
  rows: MaterialRow[];
  nextBefore: string | null;
}

/**
 * Materials of `kind` (every kind, 周期资料, or one kind), a page of whole
 * dates: the `limit` newest dates before `before`, with all their materials
 * of that kind, so a date's materials never straddle two pages.
 */
export async function listMaterials(
  db: Executor,
  userId: string,
  { kind, before, limit }: { kind: ListKind; before?: string | undefined; limit: number },
): Promise<MaterialPage> {
  const scope = and(eq(materials.userId, userId), kindFilter(kind), before === undefined ? undefined : lt(materials.date, before));
  const dateRows = await db
    .selectDistinct({ date: materials.date })
    .from(materials)
    .where(scope)
    .orderBy(desc(materials.date))
    .limit(limit + 1);
  const dates = dateRows.slice(0, limit).map((row) => row.date);
  if (dates.length === 0) return { dates, rows: [], nextBefore: null };
  const rows = await db
    .select(rowColumns)
    .from(materials)
    .where(and(scope, inArray(materials.date, dates)))
    .orderBy(desc(materials.date), kindRank);
  return { dates, rows, nextBefore: dateRows.length > limit ? dates[dates.length - 1]! : null };
}

/** The `n` newest materials of any kind (date desc, then KIND_ORDER). */
export async function latestMaterials(db: Executor, userId: string, n: number): Promise<MaterialRow[]> {
  return db.select(rowColumns).from(materials).where(eq(materials.userId, userId)).orderBy(desc(materials.date), kindRank).limit(n);
}

/**
 * Mark a material read ("学完了"; an earlier mark is kept) or unread. Null
 * when the account has no such material.
 */
export async function setMaterialRead(
  db: Executor,
  userId: string,
  { kind, date, read, now }: { kind: MaterialKind; date: string; read: boolean; now: Date },
): Promise<{ readAt: Date | null } | null> {
  const [row] = await db
    .update(materials)
    .set({ readAt: read ? sql`coalesce(${materials.readAt}, ${now.toISOString()}::timestamptz)` : null })
    .where(and(eq(materials.userId, userId), eq(materials.kind, kind), eq(materials.date, date)))
    .returning({ readAt: materials.readAt });
  return row ?? null;
}
