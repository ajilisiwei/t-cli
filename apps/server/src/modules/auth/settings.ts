import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { users } from '../../db/schema.ts';

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
});

/**
 * Every key is optional; an absent key means its default, applied by
 * clients: explanationLang zh, autoSpeakWord true, autoSpeakOnFlip true,
 * reminderHour null, showDirection false, accent indigo, themeMode system,
 * themeFixed light, themeDayStart "07:00", themeNightStart "19:00",
 * readingMode false, readingFontStep 0, importanceReview true.
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
