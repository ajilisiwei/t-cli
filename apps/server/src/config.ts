import { z } from 'zod';

/**
 * Process configuration, validated once at startup. Secrets only ever come
 * from the environment (or the secret manager that populates it).
 */
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  /** Pool size per process. The PostgreSQL instance is shared with another app. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  MIGRATE_ON_START: z.stringbool().default(false),

  /** HS256 signing key for access tokens; at least 32 bytes of entropy. */
  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(60),

  WECHAT_APPID: z.string().min(1).optional(),
  WECHAT_SECRET: z.string().min(1).optional(),
  /**
   * Development only: never call WeChat; the login code `dev:<name>` becomes
   * the openid `dev_<name>`. Refused when NODE_ENV=production (see below).
   */
  WECHAT_DEV_LOGIN: z.stringbool().default(false),

  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_MODEL: z.string().min(1).default('deepseek-v4-flash'),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),

  AI_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(20),
  AI_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(200),
  AI_INPUT_MAX_CHARS: z.coerce.number().int().positive().default(2000),

  /** false → POST /v1/tts answers 503 TTS_UNAVAILABLE without calling out. */
  TTS_ENABLED: z.stringbool().default(true),
  TTS_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(30),
  /** Upper bound for one synthesis (connect + audio). */
  TTS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  /**
   * In-memory audio cache budget in bytes (0 disables it). The production
   * container has mem_limit 256m, so keep this a small slice of it.
   */
  TTS_CACHE_MAX_BYTES: z.coerce.number().int().min(0).max(128 * 1024 * 1024).default(16 * 1024 * 1024),
  /** Run the in-process scheduler (nightly pipeline, reminders). Off in tests; admin scripts use runNow. */
  JOBS_ENABLED: z.stringbool().default(true),

  // ---- M3–M5 (docs/api-v1.md, "Learning") ----
  /** Interactive AI proxy tokens per account per local day. */
  AI_TOKENS_PER_DAY: z.coerce.number().int().positive().default(300_000),
  /** Nightly pipeline tokens per account per run. */
  AI_PIPELINE_TOKENS_PER_RUN: z.coerce.number().int().positive().default(200_000),
  /** New cards introduced per local day (D10). */
  REVIEW_NEW_PER_DAY: z.coerce.number().int().min(0).max(500).default(15),
  /** Reviews of non-new cards per local day (D10). */
  REVIEW_MAX_PER_DAY: z.coerce.number().int().min(1).max(2000).default(60),
  /** A card whose scheduled interval exceeds this many days is "已掌握" and leaves the queue. */
  MASTERED_DAYS: z.coerce.number().int().min(30).max(36_500).default(180),
  /** Operator alert mail; all three unset → alerts are log lines only. */
  ALERT_SMTP_URL: z.string().url().optional(),
  ALERT_EMAIL_FROM: z.string().min(3).optional(),
  ALERT_EMAIL_TO: z.string().min(3).optional(),
  /** WeChat subscribe-message template for review reminders; unset → reminders off. */
  WECHAT_REMINDER_TEMPLATE_ID: z.string().min(1).optional(),
  /** JSON of the template's data fields, with {due} / {date} placeholders. */
  WECHAT_REMINDER_DATA: z.string().min(2).optional(),
  /** Which mini-program version a reminder opens; `trial` while only the 体验版 exists. */
  WECHAT_REMINDER_MINIPROGRAM_STATE: z.enum(['developer', 'trial', 'formal']).default('trial'),

  // ---- v2 (docs/api-v1.md, "v2 → Lookup") ----
  /** false → POST /v1/lookup answers 503 LOOKUP_DISABLED (clients hide tap-to-look-up). */
  LOOKUP_ENABLED: z.stringbool().default(true),
  LOOKUP_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(30),
  /**
   * Upper bound for a lookup's model calls (retry included). Clients give up
   * on JSON requests after 20 s, so the server must answer (or 502) before.
   */
  LOOKUP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(19_000).default(18_000),

  // ---- v3 (docs/api-v1.md, "v3 → PDF export") ----
  /** The Typst binary (the image installs 0.13.1 on PATH); missing → 503 EXPORT_UNAVAILABLE. */
  TYPST_BIN: z.string().min(1).default('typst'),
  /** The only fonts Typst may use (system fonts are ignored); the image ships them here. */
  TYPST_FONT_PATH: z.string().min(1).default('/usr/local/share/fonts/t-cli'),
}).refine((config) => !(config.WECHAT_DEV_LOGIN && config.NODE_ENV === 'production'), {
  path: ['WECHAT_DEV_LOGIN'],
  message: 'WECHAT_DEV_LOGIN must not be enabled in production',
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse configuration from an environment map. Throws with the names of the
 * invalid variables only — values (possibly secrets) are never echoed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration: ${names.join(', ')}`);
  }
  return result.data;
}
