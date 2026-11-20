import { z } from 'zod';
import type { Config } from '../../config.ts';

/**
 * Review reminders are configured by WECHAT_REMINDER_TEMPLATE_ID and
 * WECHAT_REMINDER_DATA (docs/api-v1.md, "Reminders"). DATA is the template's
 * data fields as JSON, e.g. `{"thing1":"今天有 {due} 张卡片待复习","time2":"{date}"}`;
 * a field may also be given as `{"value": "..."}` (WeChat's own shape).
 */
export interface ReminderConfig {
  templateId: string;
  /** Field name → value template with `{due}` / `{date}` placeholders. */
  fields: Readonly<Record<string, string>>;
}

const FieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/);
const ReminderData = z
  .record(FieldName, z.union([z.string().max(200), z.object({ value: z.string().max(200) }).transform((field) => field.value)]))
  .refine((fields) => Object.keys(fields).length > 0 && Object.keys(fields).length <= 20, { message: 'expected 1–20 fields' });

/**
 * The reminder configuration, or null when reminders are off (either
 * variable unset). Throws when WECHAT_REMINDER_DATA is set but malformed, so
 * a broken deployment fails at startup — naming the variable, never its value.
 */
export function reminderConfig(config: Config): ReminderConfig | null {
  const templateId = config.WECHAT_REMINDER_TEMPLATE_ID;
  const raw = config.WECHAT_REMINDER_DATA;
  if (!templateId || !raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('Invalid configuration: WECHAT_REMINDER_DATA (not JSON)');
  }
  const parsed = ReminderData.safeParse(json);
  if (!parsed.success) throw new Error('Invalid configuration: WECHAT_REMINDER_DATA (expected an object of template fields)');
  return { templateId, fields: parsed.data };
}

/** `2026年11月17日` — accepted by WeChat's `date` and `time` field types and readable in `thing`. */
export function reminderDate(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

/** Fill `{due}` and `{date}` into every field, in WeChat's `{ value }` shape. */
export function fillReminderData(fields: Readonly<Record<string, string>>, values: { due: number; date: string }): Record<string, { value: string }> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, template]) => [
      name,
      { value: template.replaceAll('{due}', String(values.due)).replaceAll('{date}', reminderDate(values.date)) },
    ]),
  );
}
