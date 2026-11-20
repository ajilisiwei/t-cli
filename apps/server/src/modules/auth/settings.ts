import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { users } from '../../db/schema.ts';

const ExplanationLang = z.enum(['zh', 'en']);
/** Local hour (0–23) for the daily review reminder; null turns it off. */
const ReminderHour = z.number().int().min(0).max(23).nullable();

/**
 * A partial `Settings` update (docs/api-v1.md, `POST /v1/me/settings` and
 * "Account"). Strict: unknown keys are a validation error, so a client typo
 * never silently does nothing.
 */
export const SettingsPatch = z.strictObject({
  explanationLang: ExplanationLang.optional(),
  /** Read word results aloud automatically (default true on the client). */
  autoSpeakWord: z.boolean().optional(),
  /** Read a review card aloud when it is flipped (default true on the client). */
  autoSpeakOnFlip: z.boolean().optional(),
  reminderHour: ReminderHour.optional(),
});

/**
 * `{ explanationLang?, autoSpeakWord?, autoSpeakOnFlip?, reminderHour? }`.
 * Absent keys mean the default (zh, true, true, null), applied by clients.
 */
export type Settings = z.infer<typeof SettingsPatch>;

const SETTING_SCHEMAS = {
  explanationLang: ExplanationLang,
  autoSpeakWord: z.boolean(),
  autoSpeakOnFlip: z.boolean(),
  reminderHour: ReminderHour,
} as const;

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
