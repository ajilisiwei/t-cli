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
