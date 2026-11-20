/**
 * External dependencies, injected into buildApp() so tests can replace them
 * with fakes. Real implementations live in the owning module.
 */

/** Current time; tests pin it. */
export type Clock = () => Date;

/** WeChat `code2Session` (modules/auth/wechat.ts). */
export interface WechatClient {
  /** Exchange a `wx.login` code for the user's openid. Throws AppError on failure. */
  code2Session(code: string): Promise<{ openid: string; unionid?: string }>;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** Streaming chat completion (modules/ai/llm.ts, DeepSeek). */
export interface LlmClient {
  /**
   * False when the client cannot work at all (e.g. no API key), so callers
   * can refuse before charging quota. Omitted means available.
   */
  isAvailable?(): boolean;
  /** Yields content deltas in order. Aborts the upstream request when `signal` fires. */
  streamChat(messages: readonly ChatMessage[], options: { signal: AbortSignal }): AsyncIterable<string>;
}

/**
 * Regenerates one learning unit's content and cards (modules/pipeline).
 * Called when a user reports a card as wrong ("内容有误"). Resolves when the
 * item is ready again, rejects when generation failed (the item then stays
 * `needs_regen` and its cards stay suspended).
 */
export interface ItemRegenerator {
  regenerate(userId: string, itemId: string): Promise<void>;
}

/**
 * Operator alerts (modules/pipeline/alerts.ts: e-mail when ALERT_* is
 * configured, otherwise a log line). `message` must never contain user text.
 */
export interface Alerter {
  alert(kind: string, message: string): Promise<void>;
}

/** Text to speech (modules/tts/edgeTts.ts, Microsoft Edge Read Aloud). */
export interface TtsClient {
  /**
   * Synthesize `text` with the named voice and resolve with the complete mp3.
   * Rejects when synthesis fails or `signal` fires (the caller's timeout).
   */
  synthesize(text: string, voice: string, options: { signal: AbortSignal }): Promise<Uint8Array>;
}
