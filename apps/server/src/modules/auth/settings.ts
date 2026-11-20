import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { users } from '../../db/schema.ts';

const ExplanationLang = z.enum(['zh', 'en']);

/**
 * A partial `Settings` update (docs/api-v1.md, `POST /v1/me/settings`).
 * Strict: unknown keys are a validation error, so a client typo never
 * silently does nothing.
 */
export const SettingsPatch = z.strictObject({
  explanationLang: ExplanationLang.optional(),
});

/** `{ explanationLang?: 'zh' | 'en' }` (absent → 'zh' on the client). */
export type Settings = z.infer<typeof SettingsPatch>;

/**
 * The settings as the API shows them: only known keys with valid values, so
 * whatever else the jsonb column may hold never reaches a client.
 */
export function toSettings(stored: unknown): Settings {
  const source = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const lang = ExplanationLang.safeParse(source.explanationLang);
  return lang.success ? { explanationLang: lang.data } : {};
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
