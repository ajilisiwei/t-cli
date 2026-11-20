import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb, runMigrations } from './db/client.ts';
import type { AppDeps } from './deps.ts';
import { createScheduler } from './lib/scheduler.ts';
import { createLlmClient } from './modules/ai/llm.ts';
import { selectWechatClient } from './modules/auth/wechat.ts';
import { registerNotifyJobs } from './modules/notify/index.ts';
import { createAlerter, createItemRegenerator, registerPipelineJobs, type AlertLogger } from './modules/pipeline/index.ts';
import { createEdgeTtsClient } from './modules/tts/edgeTts.ts';

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });

if (config.MIGRATE_ON_START) {
  await runMigrations(db);
}

// The alerter is a dependency of the app, so it exists before app.log does;
// it logs through app.log as soon as the app is built.
let appLog: AlertLogger | null = null;
const alerter = createAlerter(config, { warn: (obj, msg) => appLog?.warn(obj, msg) });
const base = {
  config,
  db,
  clock: () => new Date(),
  wechat: selectWechatClient(config),
  llm: createLlmClient(config),
  tts: createEdgeTtsClient(),
  alerter,
};
const deps: AppDeps = { ...base, regenerator: createItemRegenerator(base) };
const app = await buildApp(deps);
appLog = app.log;

const scheduler = createScheduler({ db, clock: deps.clock, log: app.log, alerter });
registerPipelineJobs(scheduler, deps);
registerNotifyJobs(scheduler, deps);
if (config.JOBS_ENABLED) scheduler.start();
app.addHook('onClose', async () => {
  await scheduler.stop();
});
if (config.WECHAT_DEV_LOGIN) {
  app.log.warn({ nodeEnv: config.NODE_ENV }, 'WECHAT_DEV_LOGIN is on: WeChat login is faked (dev:<name> codes); development only');
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await sql.end({ timeout: 5 });
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
