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
