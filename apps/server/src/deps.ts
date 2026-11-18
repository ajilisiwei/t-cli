import type { Config } from './config.ts';
import type { Database } from './db/client.ts';
import type { Clock, LlmClient, TtsClient, WechatClient } from './ports.ts';

/** Everything route modules may use. Built in main.ts; faked in tests. */
export interface AppDeps {
  config: Config;
  db: Database;
  clock: Clock;
  wechat: WechatClient;
  llm: LlmClient;
  tts: TtsClient;
}
