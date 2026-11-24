import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { items, users } from '../../db/schema.ts';
import { toSettings } from '../auth/settings.ts';
import { retentionFor } from './fsrs.ts';

/**
 * Where a card's target retention comes from (docs/api-v1.md, "Review by
 * importance"): its item's `stars`, unless the account turned
 * `settings.importanceReview` off. Read at replay time, never stored, so a
 * change of either re-derives the schedule from the same logs.
 */

/** settings.importanceReview of the account; absent (or no such account) → the default, true. */
export async function importanceReviewOf(db: Executor, userId: string): Promise<boolean> {
  const [row] = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId));
  return toSettings(row?.settings).importanceReview ?? true;
}

/** The retention of the cards of each item in `itemIds` (the account's items only). */
export async function retentionByItem(db: Executor, userId: string, itemIds: readonly string[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const importanceReview = await importanceReviewOf(db, userId);
  const rows = await db
    .select({ id: items.id, stars: items.stars })
    .from(items)
    .where(and(eq(items.userId, userId), inArray(items.id, [...new Set(itemIds)])));
  return new Map(rows.map((row) => [row.id, retentionFor(row.stars, importanceReview)]));
}
