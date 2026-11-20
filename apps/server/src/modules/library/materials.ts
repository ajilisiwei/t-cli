import { and, desc, eq, lt } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { materials } from '../../db/schema.ts';

/** AI-written reading material (docs/api-v1.md, "Materials"): read side only. */

export type MaterialKind = 'daily' | 'weekly';

export interface MaterialView {
  date: string;
  content: Record<string, unknown>;
  createdAt: string;
}

/** The material of `date` (the week's Monday for weekly), or the latest one when `date` is absent. */
export async function getMaterial(db: Executor, userId: string, kind: MaterialKind, date?: string): Promise<MaterialView | null> {
  const scope = and(eq(materials.userId, userId), eq(materials.kind, kind), date === undefined ? undefined : eq(materials.date, date));
  const [row] = await db
    .select({ date: materials.date, content: materials.content, createdAt: materials.createdAt })
    .from(materials)
    .where(scope)
    .orderBy(desc(materials.date))
    .limit(1);
  return row ? { date: row.date, content: row.content, createdAt: row.createdAt.toISOString() } : null;
}

/** Dates that have material of `kind`, newest first, before `before` when given. */
export async function listMaterialDates(
  db: Executor,
  userId: string,
  { kind, before, limit }: { kind: MaterialKind; before?: string | undefined; limit: number },
): Promise<{ dates: string[]; nextBefore: string | null }> {
  const rows = await db
    .select({ date: materials.date })
    .from(materials)
    .where(and(eq(materials.userId, userId), eq(materials.kind, kind), before === undefined ? undefined : lt(materials.date, before)))
    .orderBy(desc(materials.date))
    .limit(limit + 1);
  const dates = rows.slice(0, limit).map((row) => row.date);
  return { dates, nextBefore: rows.length > limit ? dates[dates.length - 1]! : null };
}
