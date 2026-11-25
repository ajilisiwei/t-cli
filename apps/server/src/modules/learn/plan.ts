import {
  MATERIAL_PARTS,
  toSettings,
  type Settings,
} from '../auth/settings.ts';
import type { ExtendTopic } from '../pipeline/learnContent.ts';

/**
 * The account's learning plan (docs/api-v1.md, "v3 → Settings"): the v3
 * settings with their defaults applied, as the nightly job and the learn
 * summary read them. Pure.
 */

export type MaterialFrequency = NonNullable<Settings['materialFrequency']>;
export type MaterialPart = (typeof MATERIAL_PARTS)[number];
export type StudyLevelSetting = NonNullable<Settings['studyLevel']>;
export type MutedTopic = { topic: ExtendTopic; until: string };

export interface LearnPlan {
  materialFrequency: MaterialFrequency;
  /** 0 = Sunday … 6 = Saturday. */
  materialWeekday: number;
  materialParts: readonly MaterialPart[];
  extendEnabled: boolean;
  extendTopics: readonly ExtendTopic[];
  extendMuted: readonly MutedTopic[];
  studyLevel: StudyLevelSetting;
}

export const DEFAULT_PLAN: LearnPlan = {
  materialFrequency: 'daily',
  materialWeekday: 1,
  materialParts: MATERIAL_PARTS,
  extendEnabled: true,
  extendTopics: [],
  extendMuted: [],
  studyLevel: 'auto',
};

/** The plan from stored settings (anything invalid or absent → its default). */
export function learnPlanOf(stored: unknown): LearnPlan {
  const settings = toSettings(stored);
  return {
    materialFrequency: settings.materialFrequency ?? DEFAULT_PLAN.materialFrequency,
    materialWeekday: settings.materialWeekday ?? DEFAULT_PLAN.materialWeekday,
    materialParts: settings.materialParts ?? DEFAULT_PLAN.materialParts,
    extendEnabled: settings.extendEnabled ?? DEFAULT_PLAN.extendEnabled,
    extendTopics: settings.extendTopics ?? DEFAULT_PLAN.extendTopics,
    extendMuted: settings.extendMuted ?? DEFAULT_PLAN.extendMuted,
    studyLevel: settings.studyLevel ?? DEFAULT_PLAN.studyLevel,
  };
}

/** Topics muted on local day `today`: their `until` is later (until is exclusive). */
export function mutedTopicsOn(plan: Pick<LearnPlan, 'extendMuted'>, today: string): ExtendTopic[] {
  return plan.extendMuted.filter((entry) => entry.until > today).map((entry) => entry.topic);
}
