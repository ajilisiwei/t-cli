import type { Config } from './config.ts';
import type { Database } from './db/client.ts';
import type { Alerter, Clock, ItemRegenerator, LlmClient, TtsClient, WechatClient } from './ports.ts';

/** Everything route modules may use. Built in main.ts; faked in tests. */
export interface AppDeps {
  config: Config;
  db: Database;
  clock: Clock;
  wechat: WechatClient;
  llm: LlmClient;
  tts: TtsClient;
  /** "内容有误" → regenerate one item (modules/pipeline). */
  regenerator: ItemRegenerator;
  /** Operator alerts (modules/pipeline/alerts.ts). */
  alerter: Alerter;
}
