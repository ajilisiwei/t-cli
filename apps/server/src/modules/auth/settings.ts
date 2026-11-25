import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { EXTEND_TOPICS, type ExtendTopic } from '../pipeline/learnContent.ts';
import { LocalDate } from '../review/common.ts';

const ExplanationLang = z.enum(['zh', 'en']);
/** Local hour (0–23) for the daily review reminder; null turns it off. */
const ReminderHour = z.number().int().min(0).max(23).nullable();
/** v2 accent colours (主题色). */
export const ACCENTS = ['indigo', 'pine', 'plum', 'ochre', 'ink'] as const;
const Accent = z.enum(ACCENTS);
/** system: follow the phone; time: light from themeDayStart to themeNightStart; fixed: themeFixed. */
const ThemeMode = z.enum(['system', 'time', 'fixed']);
const ThemeFixed = z.enum(['light', 'dark']);
/** A local wall-clock time "HH:MM", 00:00–23:59. */
const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected a time HH:MM');
const ReadingFontStep = z.number().int().min(0).max(3);

// ---- v3 (docs/api-v1.md, "v3 → Settings") ----
export const MATERIAL_FREQUENCIES = ['daily', 'weekly', 'off'] as const;
/** Parts of 周期资料 (the order clients and the PDF show them in). */
export const MATERIAL_PARTS = ['words', 'phrases', 'grammar', 'story', 'exercises'] as const;
/** Topics a user can choose for 拓展资料: every ExtendTopic but `other`. */
export const USER_EXTEND_TOPICS = ['work', 'travel', 'exam', 'daily', 'tech', 'culture', 'finance', 'health'] as const satisfies readonly ExtendTopic[];
export const STUDY_LEVEL_SETTINGS = ['auto', 'A2', 'B1', 'B2', 'C1'] as const;
/** At most this many muted topics. */
export const EXTEND_MUTED_MAX = 8;

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const MaterialParts = z
  .array(z.enum(MATERIAL_PARTS))
  .min(1)
  .max(MATERIAL_PARTS.length)
  .refine(unique, 'must not repeat a part');
const ExtendTopics = z
  .array(z.enum(USER_EXTEND_TOPICS))
  .max(USER_EXTEND_TOPICS.length)
  .refine(unique, 'must not repeat a topic');
/** `until` is the first local day the topic is recommended again; one entry per topic. */
const ExtendMuted = z
  .array(z.strictObject({ topic: z.enum(EXTEND_TOPICS), until: LocalDate }))
  .max(EXTEND_MUTED_MAX)
  .refine((entries) => unique(entries.map((entry) => entry.topic)), 'must not repeat a topic');

/** One schema per key: the single source of the strict patch and of `toSettings`. */
const SETTING_SCHEMAS = {
  explanationLang: ExplanationLang,
  /** Read word results aloud automatically (default true on the client). */
  autoSpeakWord: z.boolean(),
  /** Read a review card aloud when it is flipped (default true on the client). */
  autoSpeakOnFlip: z.boolean(),
  reminderHour: ReminderHour,
  // v2 (docs/api-v1.md, "v2 → Settings"); defaults are applied by clients.
  /** Show the translate direction button (default false). */
  showDirection: z.boolean(),
  /** Default indigo. */
  accent: Accent,
  /** Default system. */
  themeMode: ThemeMode,
  /** The theme of themeMode "fixed" (default light). */
  themeFixed: ThemeFixed,
  /** Start of the light theme in themeMode "time" (default "07:00"). */
  themeDayStart: ClockTime,
  /** Start of the dark theme in themeMode "time" (default "19:00"). */
  themeNightStart: ClockTime,
  /** 阅读模式 (default false). */
  readingMode: z.boolean(),
  /** Reading-mode font size step, 0–3 (default 0). */
  readingFontStep: ReadingFontStep,
  /** Schedule reviews by importance (stars) (default true). */
  importanceReview: z.boolean(),
  // v3; defaults are applied by clients and by learnPlanOf (modules/learn/plan.ts).
  /** 周期资料: daily, weekly (a 7-day digest) or off (default daily). */
  materialFrequency: z.enum(MATERIAL_FREQUENCIES),
  /** The local weekday a weekly digest comes out, 0 = Sunday (default 1). */
  materialWeekday: z.number().int().min(0).max(6),
  /** Non-empty subset of MATERIAL_PARTS (default all); without story no story is generated. */
  materialParts: MaterialParts,
  /** 拓展资料 (default true). */
  extendEnabled: z.boolean(),
  /** Chosen topics; [] = only topics found in the account's data (default []). */
  extendTopics: ExtendTopics,
  /** Topics not recommended until `until` (exclusive), written by the dismiss endpoint (default []). */
  extendMuted: ExtendMuted,
  /** auto (from retention) or a fixed CEFR level (default auto). */
  studyLevel: z.enum(STUDY_LEVEL_SETTINGS),
} as const;

/**
 * A partial `Settings` update (docs/api-v1.md, `POST /v1/me/settings`,
 * "Account" and "v2 → Settings"). Strict: unknown keys are a validation
 * error, so a client typo never silently does nothing.
 */
export const SettingsPatch = z.strictObject({
  explanationLang: SETTING_SCHEMAS.explanationLang.optional(),
  autoSpeakWord: SETTING_SCHEMAS.autoSpeakWord.optional(),
  autoSpeakOnFlip: SETTING_SCHEMAS.autoSpeakOnFlip.optional(),
  reminderHour: SETTING_SCHEMAS.reminderHour.optional(),
  showDirection: SETTING_SCHEMAS.showDirection.optional(),
  accent: SETTING_SCHEMAS.accent.optional(),
  themeMode: SETTING_SCHEMAS.themeMode.optional(),
  themeFixed: SETTING_SCHEMAS.themeFixed.optional(),
  themeDayStart: SETTING_SCHEMAS.themeDayStart.optional(),
  themeNightStart: SETTING_SCHEMAS.themeNightStart.optional(),
  readingMode: SETTING_SCHEMAS.readingMode.optional(),
  readingFontStep: SETTING_SCHEMAS.readingFontStep.optional(),
  importanceReview: SETTING_SCHEMAS.importanceReview.optional(),
  materialFrequency: SETTING_SCHEMAS.materialFrequency.optional(),
  materialWeekday: SETTING_SCHEMAS.materialWeekday.optional(),
  materialParts: SETTING_SCHEMAS.materialParts.optional(),
  extendEnabled: SETTING_SCHEMAS.extendEnabled.optional(),
  extendTopics: SETTING_SCHEMAS.extendTopics.optional(),
  extendMuted: SETTING_SCHEMAS.extendMuted.optional(),
  studyLevel: SETTING_SCHEMAS.studyLevel.optional(),
});

/**
 * Every key is optional; an absent key means its default, applied by
 * clients: explanationLang zh, autoSpeakWord true, autoSpeakOnFlip true,
 * reminderHour null, showDirection false, accent indigo, themeMode system,
 * themeFixed light, themeDayStart "07:00", themeNightStart "19:00",
 * readingMode false, readingFontStep 0, importanceReview true; v3:
 * materialFrequency daily, materialWeekday 1, materialParts all five,
 * extendEnabled true, extendTopics [], extendMuted [], studyLevel auto.
 */
export type Settings = z.infer<typeof SettingsPatch>;

/**
 * The settings as the API shows them: only known keys with valid values, so
 * whatever else the jsonb column may hold never reaches a client.
 */
export function toSettings(stored: unknown): Settings {
  const source = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const shown: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(SETTING_SCHEMAS)) {
    if (!(key in source)) continue;
    const parsed = schema.safeParse(source[key]);
    if (parsed.success) shown[key] = parsed.data;
  }
  return SettingsPatch.parse(shown);
}

/**
 * Merge `patch` into the account's settings in one statement (jsonb `||`),
 * so concurrent updates of different keys never overwrite each other.
 * Null when the account is missing or deleted.
 */
export async function mergeSettings(db: Executor, userId: string, patch: Settings): Promise<Settings | null> {
  const [row] = await db
    .update(users)
    .set({ settings: sql`${users.settings} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .returning({ settings: users.settings });
  return row ? toSettings(row.settings) : null;
}
