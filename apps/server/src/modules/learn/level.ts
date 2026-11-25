import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import type { StudyLevel } from '../pipeline/learnContent.ts';
import type { StudyLevelSetting } from './plan.ts';

/**
 * The study level (docs/api-v1.md, "v3 → Learn summary"): the setting, or
 * with `auto` one derived from the last 30 days of reviews. The one rule
 * shared by the learn summary and the nightly job (story, extension).
 */

export const LEVEL_WINDOW_DAYS = 30;
export const DEFAULT_LEVEL: StudyLevel = 'B1';

export interface LevelStats {
  /** Share of ratings ≥ 2 on non-new cards in the window (4 decimals); null without such ratings. */
  retention30: number | null;
  /** How many such ratings (the sample behind retention30). */
  reviews30: number;
}

export interface LevelView extends LevelStats {
  setting: StudyLevelSetting;
  effective: StudyLevel;
}

/**
 * auto: B1, then C1 when retention30 ≥ 0.93 and reviews30 ≥ 300, else B2
 * when retention30 ≥ 0.88 and reviews30 ≥ 150, else A2 when retention30 <
 * 0.70 and reviews30 ≥ 50. The rule reads the rounded retention30 the API
 * shows, so what a client displays always explains the level.
 */
export function effectiveLevel(setting: StudyLevelSetting, { retention30, reviews30 }: LevelStats): StudyLevel {
  if (setting !== 'auto') return setting;
  if (retention30 === null) return DEFAULT_LEVEL;
  if (retention30 >= 0.93 && reviews30 >= 300) return 'C1';
  if (retention30 >= 0.88 && reviews30 >= 150) return 'B2';
  if (retention30 < 0.7 && reviews30 >= 50) return 'A2';
  return DEFAULT_LEVEL;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Ratings of cards that were not new (not their card's first log) in the LEVEL_WINDOW_DAYS before `now`. */
export async function levelStats(db: Executor, userId: string, now: Date): Promise<LevelStats> {
  const since = new Date(now.getTime() - LEVEL_WINDOW_DAYS * 86_400_000);
  const [row] = await db.execute<{ total: number; passed: number }>(sql`
    select count(*)::int as total, (count(*) filter (where l.rating >= 2))::int as passed
    from review_logs l
    where l.user_id = ${userId} and l.reviewed_at >= ${since.toISOString()}::timestamptz
      and exists (
        select 1 from review_logs e
        where e.user_id = l.user_id and e.card_id = l.card_id
          and (e.reviewed_at, e.id) < (l.reviewed_at, l.id)
      )`);
  const total = row?.total ?? 0;
  return { retention30: total === 0 ? null : round4((row?.passed ?? 0) / total), reviews30: total };
}

export async function accountLevel(db: Executor, userId: string, now: Date, setting: StudyLevelSetting): Promise<LevelView> {
  const stats = await levelStats(db, userId, now);
  return { setting, effective: effectiveLevel(setting, stats), ...stats };
}
