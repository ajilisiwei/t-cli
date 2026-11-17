import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb, runMigrations } from './db/client.ts';
import { createLlmClient } from './modules/ai/llm.ts';
import { createWechatClient } from './modules/auth/wechat.ts';

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });

if (config.MIGRATE_ON_START) {
  await runMigrations(db);
}

const app = await buildApp({
  config,
  db,
  clock: () => new Date(),
  wechat: createWechatClient(config),
  llm: createLlmClient(config),
});

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
