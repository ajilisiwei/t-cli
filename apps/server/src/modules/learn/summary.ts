import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { unauthorized } from '../../http/errors.ts';
import { toSettings } from '../auth/settings.ts';
import { toListItem, type MaterialListItem } from '../library/materialView.ts';
import { latestMaterials } from '../library/materials.ts';
import { reviewSummary, type DueByScope, type ReviewLimits } from '../review/queue.ts';
import { accountLevel, type LevelView } from './level.ts';
import { learnPlanOf, type MaterialFrequency } from './plan.ts';

/**
 * `GET /v1/learn/summary` (docs/api-v1.md, "v3 → Learn summary"):
 * everything the 学习 tab's first screen needs in one call.
 */

/** The newest materials of any kind shown on the first screen. */
export const SUMMARY_MATERIALS = 3;

export interface LearnSummary {
  review: { dueByScope: DueByScope; doneToday: number; estimatedMinutes: number; streakDays: number };
  materials: MaterialListItem[];
  plan: { materialFrequency: MaterialFrequency; materialWeekday: number; extendEnabled: boolean };
  level: LevelView;
}

export async function learnSummary(
  db: Executor,
  { userId, now, utcOffsetMinutes, limits }: { userId: string; now: Date; utcOffsetMinutes: number; limits: ReviewLimits },
): Promise<LearnSummary> {
  const [user] = await db
    .select({ settings: users.settings })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  if (!user) throw unauthorized('account not found');
  const plan = learnPlanOf(user.settings);
  const lang = toSettings(user.settings).explanationLang ?? 'zh';

  const [review, latest, level] = await Promise.all([
    reviewSummary(db, { userId, now, utcOffsetMinutes, limits }),
    latestMaterials(db, userId, SUMMARY_MATERIALS),
    accountLevel(db, userId, now, plan.studyLevel),
  ]);
  return {
    review: { dueByScope: review.dueByScope, doneToday: review.doneToday, estimatedMinutes: review.estimatedMinutes, streakDays: review.streakDays },
    materials: latest.map((row) => toListItem(row, lang)),
    plan: { materialFrequency: plan.materialFrequency, materialWeekday: plan.materialWeekday, extendEnabled: plan.extendEnabled },
    level,
  };
}
